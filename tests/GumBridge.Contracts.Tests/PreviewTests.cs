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
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task PublishedFrameRendersInStagingWithoutTargetWrites(bool absoluteCodeRoot)
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
            var id = "sha256:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(semantic)));
            var snapshot = JsonDocument.Parse("{\"schemaVersion\":{\"major\":1,\"minor\":0},\"snapshotId\":\"" + id + "\"," + semantic[1..]).RootElement;
            var publications = new PublicationStore(data, () => DateTimeOffset.UtcNow);
            var (transfer, missing) = publications.Begin(entry.id, snapshot);
            Assert.Equal(new[] { imageHash }, missing);
            publications.Upload(entry.id, transfer, imageHash, Convert.ToBase64String(image));
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
