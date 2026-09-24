using System;
using System.Linq;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using GumBridge.Infrastructure.Storage;

namespace GumBridge.Host;

// This host is the only plugin-facing process. No filesystem or mutation endpoints are exposed.
public sealed class PairingHost : IAsyncDisposable
{
    private readonly WebApplication app;
    private readonly WorkspaceStore workspaceStore;
    private readonly PublicationStore publicationStore;
    private readonly PreviewStore previewStore;
    private readonly PreviewOperation previewOperation;
    private readonly object mutationLock = new();
    private readonly System.Threading.SemaphoreSlim previewLock = new(1, 1);
    private readonly string dataDirectory;
    private readonly string cliToken;
    private readonly FileStream ownershipLock;
    private readonly Func<DateTimeOffset> utcNow;
    public string Address { get; private set; } = "";
    private PairingHost(WebApplication app, Func<DateTimeOffset> utcNow, string dataDirectory, FileStream ownershipLock, Func<string, string[], Task>? previewToolRunner)
    {
        this.app = app;
        this.utcNow = utcNow;
        this.dataDirectory = dataDirectory;
        this.ownershipLock = ownershipLock;
        cliToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        workspaceStore = new WorkspaceStore(dataDirectory);
        publicationStore = new PublicationStore(dataDirectory, utcNow);
        previewStore = new PreviewStore(dataDirectory);
        previewOperation = new PreviewOperation(publicationStore, previewStore, previewToolRunner);
    }

    public static async Task<PairingHost> StartAsync(int port = 48931, Func<DateTimeOffset>? utcNow = null, string? localDataDirectory = null, Func<string, string[], Task>? previewToolRunner = null)
    {
        var data = localDataDirectory ?? WorkspaceCli.DefaultDataDirectory;
        if (Path.Exists(data) && (File.GetAttributes(data) & FileAttributes.ReparsePoint) != 0) throw new IOException("Local data directory must not be linked");
        Directory.CreateDirectory(data);
        foreach (var name in new[] { "host.lock", "host.json", "workspaces.json" })
            if (Path.Exists(Path.Combine(data, name)) && (File.GetAttributes(Path.Combine(data, name)) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("Local state must not be linked");
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(data, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        // Exclusive lock denies a second host, even if its requested port differs.
        var ownershipLock = new FileStream(Path.Combine(data, "host.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders(); // Local request bodies and CLI credentials must not enter normal logs.
        builder.WebHost.UseKestrel(options => { options.Limits.MaxRequestBodySize = 6 * 1024 * 1024; options.Listen(IPAddress.Loopback, port); });
        var app = builder.Build();
        var host = new PairingHost(app, utcNow ?? (() => DateTimeOffset.UtcNow), data, ownershipLock, previewToolRunner);
        app.Use(async (context, next) =>
        {
            var request = context.Request;
            var authority = request.Host;
            var origin = request.Headers.Origin.ToString();
            var allowedOrigin = origin == "null" || origin == "https://www.figma.com" || origin == "https://figma.com";
            if ((authority.Host != "localhost" && authority.Host != "127.0.0.1") ||
                authority.Port != context.Connection.LocalPort ||
                !IPAddress.IsLoopback(context.Connection.RemoteIpAddress ?? IPAddress.None) ||
                (origin.Length > 0 && !allowedOrigin))
            {
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
                return;
            }
            var path = request.Path.Value;
            var methodName = request.Method;
            var pluginRoute = (methodName == "GET" && path is "/v1/workspaces" or "/v1/publications" or "/v1/preview-target" or "/v1/artifacts") ||
                (methodName == "POST" && path is "/v1/publications/begin" or "/v1/publications/blobs" or "/v1/publications/finalize" or "/v1/previews");
            var localRoute = methodName == "POST" && (path is "/v1/local/sample" or "/v1/local/register") && origin.Length == 0;
            if (origin.Length > 0 && (path is "/v1/local/sample" or "/v1/local/register")) { context.Response.StatusCode = StatusCodes.Status403Forbidden; return; }
            if (methodName != "OPTIONS" && !pluginRoute && !localRoute) { context.Response.StatusCode = StatusCodes.Status404NotFound; return; }
            if (origin.Length > 0)
            {
                context.Response.Headers.AccessControlAllowOrigin = origin;
                context.Response.Headers.Vary = "Origin";
            }
            if (request.Method == "OPTIONS")
            {
                var method = request.Headers.AccessControlRequestMethod.ToString();
                if (origin.Length == 0 || !((request.Path == "/v1/workspaces" && method == "GET") ||
                    ((request.Path == "/v1/publications/begin" || request.Path == "/v1/publications/blobs" || request.Path == "/v1/publications/finalize") && method == "POST") ||
                    (request.Path == "/v1/publications" && method == "GET") ||
                    (request.Path == "/v1/previews" && method == "POST") ||
                    (request.Path == "/v1/artifacts" && method == "GET") ||
                    (request.Path == "/v1/preview-target" && method == "GET")) ||
                    request.Headers.AccessControlRequestHeaders.ToString().ToLowerInvariant() is not ("" or "content-type"))
                {
                    context.Response.StatusCode = StatusCodes.Status403Forbidden;
                    return;
                }
                context.Response.Headers.AccessControlAllowMethods = "GET, POST";
                context.Response.Headers.AccessControlAllowHeaders = "Content-Type";
                context.Response.StatusCode = StatusCodes.Status204NoContent;
                return;
            }
            await next(context);
        });
        app.MapGet("/v1/workspaces", (HttpContext context) =>
            Results.Json(new WorkspacesResponse(new SchemaVersion(1, 0), host.workspaceStore.List())));
        app.MapPost("/v1/local/sample", (HttpContext context, LocalSample request) =>
            host.LocalAuthorized(context) ? host.Mutate(() => host.workspaceStore.Init(request.directory)) : Results.Unauthorized());
        app.MapPost("/v1/local/register", (HttpContext context, LocalRegistration request) =>
            host.LocalAuthorized(context) ? host.Mutate(() => host.workspaceStore.Register(request.directory, request.project, request.gumx)) : Results.Unauthorized());
        app.MapPost("/v1/publications/begin", (HttpContext context, BeginRequest request) => host.Publication(context, request.workspaceId, () =>
        {
            var (transferId, missing) = host.publicationStore.Begin(request.workspaceId, request.snapshot);
            return Results.Json(new { schemaVersion = new SchemaVersion(1, 0), transferId, missing });
        }, request.schemaVersion));
        app.MapPost("/v1/publications/blobs", (HttpContext context, BlobRequest request) => host.Publication(context, request.workspaceId, () =>
        {
            host.publicationStore.Upload(request.workspaceId, request.transferId, request.hash, request.bytes);
            return Results.Json(new { schemaVersion = new SchemaVersion(1, 0), accepted = true });
        }, request.schemaVersion));
        app.MapPost("/v1/publications/finalize", (HttpContext context, FinalizeRequest request) => host.Publication(context, request.workspaceId, () =>
        {
            var (snapshotId, status) = host.publicationStore.Finalize(request.workspaceId, request.transferId);
            return Results.Json(new { schemaVersion = new SchemaVersion(1, 0), snapshotId, status });
        }, request.schemaVersion));
        app.MapGet("/v1/publications", (HttpContext context, string workspaceId) => host.Publication(context, workspaceId, () =>
            Results.Json(new { schemaVersion = new SchemaVersion(1, 0), snapshots = host.publicationStore.List(workspaceId) }), new SchemaVersion(1, 0)));
        app.MapGet("/v1/preview-target", (HttpContext context, string workspaceId) =>
        {
            if (host.workspaceStore.Find(workspaceId) is not { } entry) return Results.NotFound();
            try { return Results.Json(new { schemaVersion = new SchemaVersion(1, 0), workspaceId, targetHash = PreviewOperation.TargetHash(entry) }); }
            catch (Exception e) when (e is ArgumentException or IOException) { return Results.Conflict(new { code = "TOOLCHAIN_MISMATCH" }); }
        });
        app.MapPost("/v1/previews", async (HttpContext context, PreviewRequest request) =>
        {
            if (request.schemaVersion != new SchemaVersion(1, 0) || host.workspaceStore.Find(request.workspaceId) is not { } entry) return Results.BadRequest(new { code = "INVALID_PREVIEW_REQUEST" });
            if (!await host.previewLock.WaitAsync(0)) return Results.StatusCode(429);
            try
            {
                var (artifactId, outputHash, targetHash) = await host.previewOperation.CreateAsync(entry, request.snapshotId, request.targetHash);
                return Results.Json(new { schemaVersion = new SchemaVersion(1, 0), snapshotId = request.snapshotId, workspaceId = entry.id, targetHash, outputHash, artifactId });
            }
            catch (ArgumentException) { return Results.BadRequest(new { code = "INVALID_PREVIEW_REQUEST" }); }
            catch (PreviewToolFailure e) { return Results.Conflict(new { code = e.Code, stage = e.Stage, details = e.Details }); }
            catch (InvalidOperationException e) { return Results.Conflict(new { code = PreviewOperation.ErrorCode(e.Message), stage = "preview", details = PreviewOperation.ToolFailure("preview", "", e.Message).Details }); }
            catch (IOException e) { return Results.Conflict(new { code = "VALIDATION_FAILED", stage = "preview", details = PreviewOperation.ToolFailure("preview", "", e.Message).Details }); }
            finally { host.previewLock.Release(); }
        });
        app.MapGet("/v1/artifacts", (HttpContext context, string workspaceId, string snapshotId, string targetHash, string artifactId) =>
        {
            if (host.workspaceStore.Find(workspaceId) is not { } entry) return Results.NotFound();
            try
            {
                if (PreviewOperation.TargetHash(entry) != targetHash) return Results.Conflict(new { code = "STALE_TARGET" });
                return Results.File(host.previewStore.Read(workspaceId, snapshotId, targetHash, artifactId), "image/png");
            }
            catch (ArgumentException) { return Results.NotFound(); }
            catch (IOException) { return Results.Conflict(new { code = "INVALID_ARTIFACT" }); }
        });
        await app.StartAsync();
        host.Address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
        var descriptor = Path.Combine(data, "host.json");
        File.WriteAllText(descriptor, JsonSerializer.Serialize(new LocalDescriptor(host.Address, host.cliToken)));
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(descriptor, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        return host;
    }
    private IResult Publication(HttpContext context, string workspace, Func<IResult> action, SchemaVersion version)
    {
        if (version != new SchemaVersion(1, 0) || !workspaceStore.Contains(workspace)) return Results.BadRequest(new { code = "INVALID_PUBLICATION_REQUEST" });
        try { lock (mutationLock) return action(); }
        catch (ArgumentException) { return Results.BadRequest(new { code = "INVALID_PUBLICATION_REQUEST" }); }
        catch (InvalidOperationException) { return Results.Conflict(new { code = "INCOMPLETE_PUBLICATION" }); }
        catch (IOException) { return Results.Conflict(new { code = "PUBLICATION_CONFLICT" }); }
        catch (JsonException) { return Results.BadRequest(new { code = "INVALID_PUBLICATION_REQUEST" }); }
    }
    private string? Token(HttpContext context)
    {
        var authorization = context.Request.Headers.Authorization.ToString();
        return authorization.StartsWith("Bearer ", StringComparison.Ordinal) && authorization.Length == 71
            ? authorization.Substring(7) : null;
    }
    private bool LocalAuthorized(HttpContext context) => context.Request.Headers.Origin.Count == 0 && Token(context) is { } token &&
        CryptographicOperations.FixedTimeEquals(System.Text.Encoding.ASCII.GetBytes(token), System.Text.Encoding.ASCII.GetBytes(cliToken));
    private IResult Mutate(Func<WorkspaceEntry> action)
    {
        try { lock (mutationLock) { var entry = action(); return Results.Json(new { entry.id, entry.label, entry.kind }); } }
        catch (ArgumentException) { return Results.BadRequest(new { code = "INVALID_WORKSPACE_PATH" }); }
        catch (IOException) { return Results.Conflict(new { code = "WORKSPACE_CONFLICT" }); }
    }
    public async ValueTask DisposeAsync()
    {
        await app.DisposeAsync();
        File.Delete(Path.Combine(dataDirectory, "host.json"));
        ownershipLock.Dispose();
    }
    private sealed record PreviewRequest(SchemaVersion schemaVersion, string workspaceId, string snapshotId, string targetHash);
    private sealed record BeginRequest(SchemaVersion schemaVersion, string workspaceId, JsonElement snapshot);
    private sealed record BlobRequest(SchemaVersion schemaVersion, string workspaceId, string transferId, string hash, string bytes);
    private sealed record FinalizeRequest(SchemaVersion schemaVersion, string workspaceId, string transferId);
    private sealed record LocalSample(string directory);
    private sealed record LocalRegistration(string directory, string project, string gumx);
    private sealed record SchemaVersion(int major, int minor);
    private sealed record WorkspacesResponse(SchemaVersion schemaVersion, object[] workspaces);
    private sealed record LocalDescriptor(string address, string token);
}
