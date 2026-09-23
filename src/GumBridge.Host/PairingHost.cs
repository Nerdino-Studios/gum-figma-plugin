using System;
using System.Collections.Concurrent;
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

namespace GumBridge.Host;

// This host is the only plugin-facing process. No filesystem or mutation endpoints are exposed.
public sealed class PairingHost : IAsyncDisposable
{
    private readonly WebApplication app;
    private readonly WorkspaceStore workspaceStore;
    private readonly object mutationLock = new();
    private readonly string dataDirectory;
    private readonly string cliToken;
    private readonly FileStream ownershipLock;
    private readonly Func<DateTimeOffset> utcNow;
    private readonly ConcurrentDictionary<string, DateTimeOffset> challenges = new();
    private readonly ConcurrentDictionary<string, byte> sessions = new();
    public string Address { get; private set; } = "";
    private PairingHost(WebApplication app, Func<DateTimeOffset> utcNow, string dataDirectory, FileStream ownershipLock)
    {
        this.app = app;
        this.utcNow = utcNow;
        this.dataDirectory = dataDirectory;
        this.ownershipLock = ownershipLock;
        cliToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        workspaceStore = new WorkspaceStore(dataDirectory);
    }

    // Only the local console path calls this method in production; never expose it as HTTP.
    public string IssueChallengeForLocalConsent()
    {
        foreach (var item in challenges.Where(item => item.Value <= utcNow())) challenges.TryRemove(item.Key, out _);
        var challenge = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        challenges[challenge] = utcNow().AddMinutes(2);
        return challenge;
    }

    public static async Task<PairingHost> StartAsync(int port = 48931, Func<DateTimeOffset>? utcNow = null, string? localDataDirectory = null)
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
        builder.Logging.ClearProviders(); // Requests, challenge bodies and tokens must not enter normal logs.
        builder.WebHost.UseKestrel(options => { options.Limits.MaxRequestBodySize = 1024; options.Listen(IPAddress.Loopback, port); });
        var app = builder.Build();
        var host = new PairingHost(app, utcNow ?? (() => DateTimeOffset.UtcNow), data, ownershipLock);
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
            if (origin.Length > 0)
            {
                context.Response.Headers.AccessControlAllowOrigin = origin;
                context.Response.Headers.Vary = "Origin";
            }
            if (request.Method == "OPTIONS")
            {
                var method = request.Headers.AccessControlRequestMethod.ToString();
                if (origin.Length == 0 || !((request.Path == "/v1/workspaces" && method == "GET") ||
                    ((request.Path == "/v1/pair" || request.Path == "/v1/session") && method == "POST")) ||
                    request.Headers.AccessControlRequestHeaders.ToString().ToLowerInvariant() is not ("authorization" or "content-type" or "content-type,authorization" or "authorization,content-type"))
                {
                    context.Response.StatusCode = StatusCodes.Status403Forbidden;
                    return;
                }
                context.Response.Headers.AccessControlAllowMethods = "GET, POST";
                context.Response.Headers.AccessControlAllowHeaders = "Authorization, Content-Type";
                context.Response.StatusCode = StatusCodes.Status204NoContent;
                return;
            }
            await next(context);
        });
        app.MapPost("/v1/pair", async (HttpContext context) =>
        {
            if (context.Request.ContentLength is > 1024) return Results.StatusCode(413);
            PairRequest? payload;
            try { payload = await context.Request.ReadFromJsonAsync<PairRequest>(); }
            catch (JsonException) { return Results.BadRequest(); }
            if (payload?.challenge is not { Length: 64 } value ||
                !host.challenges.TryRemove(value, out var expires) || expires <= host.utcNow())
                return Results.Unauthorized();
            var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            host.sessions[token] = 0;
            return Results.Json(new SessionResponse(token, new SchemaVersion(1, 0)));
        });
        app.MapGet("/v1/workspaces", (HttpContext context) =>
            host.Authenticated(context) ? Results.Json(new WorkspacesResponse(new SchemaVersion(1, 0), host.workspaceStore.List())) : Results.Unauthorized());
        app.MapPost("/v1/local/sample", (HttpContext context, LocalSample request) =>
            host.LocalAuthorized(context) ? host.Mutate(() => host.workspaceStore.Init(request.directory)) : Results.Unauthorized());
        app.MapPost("/v1/local/register", (HttpContext context, LocalRegistration request) =>
            host.LocalAuthorized(context) ? host.Mutate(() => host.workspaceStore.Register(request.directory, request.project, request.gumx)) : Results.Unauthorized());
        app.MapPost("/v1/session", (HttpContext context) =>
        {
            var token = host.Token(context);
            if (token is null || !host.sessions.TryRemove(token, out _)) return Results.Unauthorized();
            return Results.NoContent();
        });
        await app.StartAsync();
        host.Address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
        var descriptor = Path.Combine(data, "host.json");
        File.WriteAllText(descriptor, JsonSerializer.Serialize(new LocalDescriptor(host.Address, host.cliToken)));
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(descriptor, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        return host;
    }
    private string? Token(HttpContext context)
    {
        var authorization = context.Request.Headers.Authorization.ToString();
        return authorization.StartsWith("Bearer ", StringComparison.Ordinal) && authorization.Length == 71
            ? authorization.Substring(7) : null;
    }
    private bool Authenticated(HttpContext context) => Token(context) is { } token && sessions.ContainsKey(token);
    private bool LocalAuthorized(HttpContext context) => Token(context) is { } token &&
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
    private sealed record LocalSample(string directory);
    private sealed record LocalRegistration(string directory, string project, string gumx);
    private sealed record PairRequest(string challenge);
    private sealed record SessionResponse(string token, SchemaVersion schemaVersion);
    private sealed record SchemaVersion(int major, int minor);
    private sealed record WorkspacesResponse(SchemaVersion schemaVersion, object[] workspaces);
    private sealed record LocalDescriptor(string address, string token);
}
