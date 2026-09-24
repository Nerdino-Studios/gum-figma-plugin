using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using GumBridge.Host;
using GumBridge.Infrastructure.Gum;
using GumBridge.Infrastructure.Storage;
using Xunit;

namespace GumBridge.Contracts.Tests;

public sealed class PreviewTests
{
    private static string TempRoot => OperatingSystem.IsMacOS() ? "/private/tmp" : Path.GetTempPath();
    [Fact]
    public async Task ArtifactAndPreviewRoutesRequireSession()
    {
        var data = Path.Combine(TempRoot, "preview-http-" + Guid.NewGuid().ToString("N"));
        try
        {
            await using (var host = await PairingHost.StartAsync(0, localDataDirectory: data))
            using (var client = new HttpClient { BaseAddress = new Uri(host.Address.Replace("127.0.0.1", "localhost")) })
            {
                Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/v1/preview-target?workspaceId=" + new string('a', 32))).StatusCode);
                Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync("/v1/previews", new { schemaVersion = new { major = 1, minor = 0 }, workspaceId = new string('a', 32), snapshotId = "sha256:" + new string('b', 64), targetHash = "sha256:" + new string('c', 64) })).StatusCode);
                var artifactRoute = "/v1/artifacts?workspaceId=" + new string('a', 32) + "&snapshotId=sha256:" + new string('b', 64) + "&targetHash=sha256:" + new string('c', 64) + "&artifactId=sha256:" + new string('d', 64);
                Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(artifactRoute)).StatusCode);
                var challenge = host.IssueChallengeForLocalConsent();
                var pair = await client.PostAsJsonAsync("/v1/pair", new { challenge });
                var token = (await pair.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("token").GetString();
                client.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
                Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(artifactRoute)).StatusCode);
                Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/v1/previews", new { schemaVersion = new { major = 1, minor = 0 }, workspaceId = new string('a', 32), snapshotId = "sha256:" + new string('b', 64), targetHash = "sha256:" + new string('c', 64) })).StatusCode);
            }
        }
        finally { if (Directory.Exists(data)) Directory.Delete(data, true); }
    }
    [Fact]
    public void OtherPreviewErrorsRetainStableCodeAndContext()
    {
        Assert.Equal("VALIDATION_FAILED", PreviewOperation.ErrorCode("Missing code generation settings"));
        Assert.Equal("VALIDATION_FAILED", PreviewOperation.ErrorCode("Invalid code generation settings"));
        Assert.Equal("TOOLCHAIN_MISMATCH", PreviewOperation.ErrorCode("TOOLCHAIN_MISMATCH: expected KernSmith"));
    }

    [Fact]
    public async Task FailedNativeToolIncludesStepBoundedOutputAndRetainsUnauthorizedBoundary()
    {
        var data = Path.Combine(TempRoot, "preview-failure-" + Guid.NewGuid().ToString("N"));
        try
        {
            await using var host = await PairingHost.StartAsync(0, localDataDirectory: data);
            using var client = new HttpClient { BaseAddress = new Uri(host.Address.Replace("127.0.0.1", "localhost")) };
            var request = new { schemaVersion = new { major = 1, minor = 0 }, workspaceId = new string('a', 32), snapshotId = "sha256:" + new string('b', 64), targetHash = "sha256:" + new string('c', 64) };
            var denied = await client.PostAsJsonAsync("/v1/previews", request);
            Assert.Equal(HttpStatusCode.Unauthorized, denied.StatusCode);
            Assert.DoesNotContain("gumcli", await denied.Content.ReadAsStringAsync());
            var failure = PreviewOperation.ToolFailure("check", "", "Missing screen /private/tmp/example.gusx " + new string('x', 5000));
            Assert.Equal("VALIDATION_FAILED", failure.Code);
            Assert.Equal("gumcli check", failure.Stage);
            Assert.Contains("Missing screen /private/tmp/example.gusx", failure.Details);
            Assert.Contains("[truncated]", failure.Details);
            Assert.True(failure.Details.Length <= 2100);
            var stdout = PreviewOperation.ToolFailure("codegen", "Missing output in /private/tmp/build", "");
            Assert.Equal("gumcli codegen", stdout.Stage);
            Assert.Contains("Missing output in /private/tmp/build", stdout.Details);
            var secrets = PreviewOperation.ToolFailure("check", "", "Authorization: Bearer secret123 challenge=private456");
            Assert.DoesNotContain("secret123", secrets.Details);
            Assert.DoesNotContain("private456", secrets.Details);
        }
        finally { if (Directory.Exists(data)) Directory.Delete(data, true); }
    }

    [Fact]
    public async Task AuthenticatedPreviewSerializesFailedGumCliCheckWithoutLeakingToUnauthorizedCaller()
    {
        var data = Path.Combine(TempRoot, "preview-http-tool-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(data);
        try
        {
            var entry = new WorkspaceStore(data).Init(Path.Combine(data, "sample"));
            var semantic = "{\"documentNamespace\":\"test\",\"nodes\":[{\"clipsContent\":false,\"height\":100,\"id\":\"1:1\",\"layoutMode\":\"NONE\",\"name\":\"Frame\",\"parentId\":null,\"type\":\"FRAME\",\"visible\":true,\"width\":100,\"x\":0,\"y\":0}],\"rootAliases\":[{\"alias\":\"Main\",\"rootId\":\"1:1\"}],\"selectedRootIds\":[\"1:1\"]}";
            var id = "sha256:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(semantic)));
            var snapshot = JsonDocument.Parse("{\"schemaVersion\":{\"major\":1,\"minor\":0},\"snapshotId\":\"" + id + "\"," + semantic[1..]).RootElement;
            var publications = new PublicationStore(data, () => DateTimeOffset.UtcNow);
            var (transfer, missing) = publications.Begin(entry.id, snapshot);
            Assert.Empty(missing);
            publications.Finalize(entry.id, transfer);
            // Run the real pinned GumCli against an absent project from the preview's staging directory.
            async Task FailingCheck(string stage, string[] args)
            {
                var run = typeof(PreviewOperation).GetMethod("Run", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic)!;
                await (Task)run.Invoke(null, new object[] { stage, new[] { "check", Path.Combine(stage, "missing.gumx") } })!;
            }
            await using var host = await PairingHost.StartAsync(0, localDataDirectory: data, previewToolRunner: FailingCheck);
            using var client = new HttpClient { BaseAddress = new Uri(host.Address.Replace("127.0.0.1", "localhost")) };
            var request = new { schemaVersion = new { major = 1, minor = 0 }, workspaceId = entry.id, snapshotId = id, targetHash = PreviewOperation.TargetHash(entry) };
            var denied = await client.PostAsJsonAsync("/v1/previews", request);
            Assert.Equal(HttpStatusCode.Unauthorized, denied.StatusCode);
            Assert.DoesNotContain("gumcli", await denied.Content.ReadAsStringAsync());
            var challenge = host.IssueChallengeForLocalConsent();
            var pair = await client.PostAsJsonAsync("/v1/pair", new { challenge });
            var token = (await pair.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("token").GetString();
            client.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
            var response = await client.PostAsJsonAsync("/v1/previews", request);
            Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
            var text = await response.Content.ReadAsStringAsync();
            var failure = JsonDocument.Parse(text).RootElement;
            Assert.Equal("VALIDATION_FAILED", failure.GetProperty("code").GetString());
            Assert.Equal("gumcli check", failure.GetProperty("stage").GetString());
            Assert.Contains("missing.gumx", failure.GetProperty("details").GetString(), StringComparison.OrdinalIgnoreCase);
            Assert.True(text.Length < 2500);
            Assert.DoesNotContain(token!, text);
            Assert.DoesNotContain(challenge, text);
            File.Delete(Path.Combine(Path.GetDirectoryName(Path.Combine(entry.root, entry.gumx))!, "ProjectCodeSettings.codsj"));
            var missingSettings = await client.PostAsJsonAsync("/v1/previews", new { request.schemaVersion, request.workspaceId, request.snapshotId, targetHash = PreviewOperation.TargetHash(entry) });
            Assert.Equal(HttpStatusCode.Conflict, missingSettings.StatusCode);
            var other = (await missingSettings.Content.ReadFromJsonAsync<JsonElement>());
            Assert.Equal("VALIDATION_FAILED", other.GetProperty("code").GetString());
            Assert.Equal("preview", other.GetProperty("stage").GetString());
            Assert.Contains("Missing code generation settings", other.GetProperty("details").GetString());
        }
        finally { Directory.Delete(data, true); }
    }

    [Fact]
    public async Task FailedRealGumCliCheckCarriesNativeStepAndOutput()
    {
        var stage = Path.Combine(TempRoot, "preview-tool-failure-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(Path.Combine(stage, ".config"));
            var manifest = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", ".config", "dotnet-tools.json"));
            File.Copy(manifest, Path.Combine(stage, ".config", "dotnet-tools.json"));
            // Exercise the same isolated process boundary as a preview, with a missing Gum project.
            var run = typeof(PreviewOperation).GetMethod("Run", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic)!;
            var failure = await Assert.ThrowsAsync<PreviewToolFailure>(async () =>
                await (Task)run.Invoke(null, new object[] { stage, new[] { "check", Path.Combine(stage, "missing.gumx") } })!);
            Assert.Equal("gumcli check", failure.Stage);
            Assert.Contains("missing.gumx", failure.Details, StringComparison.OrdinalIgnoreCase);
        }
        finally { if (Directory.Exists(stage)) Directory.Delete(stage, true); }
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, false)]
    [InlineData(false, true)]
    public async Task PublishedFrameRendersInStagingWithoutTargetWrites(bool absoluteCodeRoot, bool emptyFrame)
    {
        var data = Path.Combine(TempRoot, "preview-native-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(data);
        try
        {
            var entry = new WorkspaceStore(data).Init(Path.Combine(data, "sample"));
            var gumx = Path.Combine(entry.root, entry.gumx);
            var settings = Path.Combine(Path.GetDirectoryName(gumx)!, "ProjectCodeSettings.codsj");
            // Both an external absolute root and a relative traversal must be confined to staging.
            var codeRoot = absoluteCodeRoot ? data.Replace("\\", "\\\\") : "../../../../../../";
            File.WriteAllText(settings, File.ReadAllText(settings).Replace("\"../../\"", "\"" + codeRoot + "\""));
            var original = File.ReadAllBytes(gumx);
            var before = Directory.GetFiles(entry.root, "*", SearchOption.AllDirectories).ToDictionary(
                file => Path.GetRelativePath(entry.root, file), file => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))));
            var image = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==");
            var imageHash = "sha256:" + Convert.ToHexStringLower(SHA256.HashData(image));
            var semantic = "{\"documentNamespace\":\"test\",\"nodes\":[{\"clipsContent\":false,\"height\":100,\"id\":\"1:1\",\"layoutMode\":\"NONE\",\"name\":\"Frame\",\"parentId\":null,\"type\":\"FRAME\",\"visible\":true,\"width\":100,\"x\":0,\"y\":0},{\"characters\":\"Hello\",\"fontFamily\":\"Arial\",\"fontSize\":24,\"fontStyle\":\"Regular\",\"height\":30,\"id\":\"1:2\",\"name\":\"Label\",\"parentId\":\"1:1\",\"type\":\"TEXT\",\"visible\":true,\"width\":90,\"x\":0,\"y\":0},{\"height\":1,\"id\":\"1:3\",\"imageHash\":\"" + imageHash + "\",\"name\":\"Logo\",\"parentId\":\"1:1\",\"scaleMode\":\"FIT\",\"type\":\"IMAGE\",\"visible\":true,\"width\":1,\"x\":0,\"y\":40}],\"rootAliases\":[{\"alias\":\"Main\",\"rootId\":\"1:1\"}],\"selectedRootIds\":[\"1:1\"]}";
            if (emptyFrame) semantic = "{\"documentNamespace\":\"test\",\"nodes\":[{\"clipsContent\":false,\"height\":100,\"id\":\"1:1\",\"layoutMode\":\"NONE\",\"name\":\"Frame\",\"parentId\":null,\"type\":\"FRAME\",\"visible\":true,\"width\":100,\"x\":0,\"y\":0}],\"rootAliases\":[{\"alias\":\"Main\",\"rootId\":\"1:1\"}],\"selectedRootIds\":[\"1:1\"]}";
            var id = "sha256:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(semantic)));
            var snapshot = JsonDocument.Parse("{\"schemaVersion\":{\"major\":1,\"minor\":0},\"snapshotId\":\"" + id + "\"," + semantic[1..]).RootElement;
            var publications = new PublicationStore(data, () => DateTimeOffset.UtcNow);
            var (transfer, missing) = publications.Begin(entry.id, snapshot);
            Assert.Equal(emptyFrame ? Array.Empty<string>() : new[] { imageHash }, missing);
            if (!emptyFrame) publications.Upload(entry.id, transfer, imageHash, Convert.ToBase64String(image));
            publications.Finalize(entry.id, transfer);
            var artifacts = new PreviewStore(data);
            var operation = new PreviewOperation(publications, artifacts);
            var target = PreviewOperation.TargetHash(entry);
            await Assert.ThrowsAsync<InvalidOperationException>(() => operation.CreateAsync(entry, id, "sha256:" + new string('f', 64)));
            await Assert.ThrowsAsync<ArgumentException>(() => operation.CreateAsync(entry, "sha256:" + new string('f', 64), target));
            var (artifact, output, _) = await operation.CreateAsync(entry, id, target);
            Assert.Equal(output, "sha256:" + Convert.ToHexStringLower(SHA256.HashData(artifacts.Read(entry.id, id, target, artifact))));
            Assert.Equal(original, File.ReadAllBytes(gumx));
            foreach (var (relative, hash) in before)
                Assert.Equal(hash, Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(Path.Combine(entry.root, relative)))));
            Assert.Equal(before.Count, Directory.GetFiles(entry.root, "*", SearchOption.AllDirectories).Length);
            Assert.Empty(Directory.GetFiles(data, "*.Generated.cs", SearchOption.TopDirectoryOnly));
            File.AppendAllText(gumx, "<!-- local edit -->");
            Assert.NotEqual(target, PreviewOperation.TargetHash(entry));
            await Assert.ThrowsAsync<InvalidOperationException>(() => operation.CreateAsync(entry, id, target));
        }
        finally { Directory.Delete(data, true); }
    }

    [Theory]
    [InlineData(4097, 4097)]
    [InlineData(65536, 1)]
    public void OversizedDecodedImageIsRejectedBeforeNativeTools(uint width, uint height)
    {
        Assert.Throws<ArgumentException>(() => PreviewOperation.ValidateImagePixels(new[] { (width, height) }));
    }

    [Fact]
    public void AggregateDecodedImagesAreBounded()
    {
        Assert.Throws<ArgumentException>(() => PreviewOperation.ValidateImagePixels(new[] { (2048u, 2048u), (2048u, 2048u), (2048u, 2048u), (2048u, 2048u), (2048u, 2048u) }));
    }

    [Fact]
    public void PublishedIdentityAndArtifactIntegrityAreRequired()
    {
        var data = Path.Combine(TempRoot, "preview-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(data);
        try
        {
            var workspace = new string('a', 32);
            var snapshot = "sha256:" + new string('b', 64);
            var target = "sha256:" + new string('c', 64);
            var store = new PreviewStore(data);
            Assert.Throws<ArgumentException>(() => store.Read(workspace, snapshot, target, "sha256:" + new string('d', 64)));
            Assert.Throws<ArgumentException>(() => store.Create(workspace, snapshot, target, Array.Empty<byte>()));
            var png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==");
            var artifact = store.Create(workspace, snapshot, target, png);
            Assert.Equal(png, store.Read(workspace, snapshot, target, artifact));
            Assert.Throws<IOException>(() => store.Read(workspace, snapshot, "sha256:" + new string('e', 64), artifact));
            Assert.Throws<ArgumentException>(() => store.Read(new string('f', 32), snapshot, target, artifact));
            File.WriteAllBytes(Path.Combine(data, "previews", workspace, artifact[7..] + ".json"), new byte[] { 1, 2, 3 });
            Assert.Throws<IOException>(() => store.Read(workspace, snapshot, target, artifact));
        }
        finally { Directory.Delete(data, true); }
    }
}
