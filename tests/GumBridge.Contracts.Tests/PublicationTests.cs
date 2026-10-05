using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using GumBridge.Host;
using Xunit;

namespace GumBridge.Contracts.Tests;

public sealed class PublicationTests
{
    [Fact]
    public async Task MissingCorruptAndRetriedTransferOnlyPublishesOnceAcrossRestart()
    {
        var data = Path.Combine("/private/tmp", "gumbridge-publication-" + Guid.NewGuid().ToString("N"));
        var root = Path.Combine(data, "target");
        Directory.CreateDirectory(root);
        File.WriteAllText(Path.Combine(root, "game.csproj"), "original project");
        File.WriteAllText(Path.Combine(root, "ui.gumx"), "original gum");
        var workspace = new WorkspaceStore(data).Register(root, "game.csproj", "ui.gumx").id;
        var bytes = Encoding.UTF8.GetBytes("asset");
        var blob = "sha256:" + Convert.ToHexStringLower(SHA256.HashData(bytes));
        var semantic = new { documentNamespace = "design-1", selectedRootIds = new[] { "1:2" }, rootAliases = new[] { new { rootId = "1:2", alias = "Main" } }, nodes = new object[] {
            new { id = "1:2", parentId = (string?)null, type = "FRAME", name = "Screen", x = 0, y = 0, width = 100, height = 100, visible = true, layoutMode = "NONE", clipsContent = false },
            new { id = "1:3", parentId = "1:2", type = "IMAGE", name = "Logo", x = 0, y = 0, width = 10, height = 10, visible = true, imageHash = blob, scaleMode = "FIT" }
        } };
        var json = JsonSerializer.Serialize(semantic);
        var id = "sha256:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(Canonical(JsonDocument.Parse(json).RootElement))));
        var snapshot = JsonSerializer.Deserialize<JsonElement>(JsonSerializer.Serialize(new { schemaVersion = new { major = 1, minor = 0 }, snapshotId = id, semantic.documentNamespace, semantic.selectedRootIds, semantic.rootAliases, semantic.nodes }));
        var now = DateTimeOffset.UtcNow;
        try
        {
            await using (var host = await PairingHost.StartAsync(0, () => now, data))
            {
                using var client = await Paired(host);
                Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/v1/publications/begin", new { workspaceId = workspace, snapshot })).StatusCode);
                var begin = await client.PostAsJsonAsync("/v1/publications/begin", new { schemaVersion = new { major = 1, minor = 0 }, workspaceId = workspace, snapshot });
                Assert.Equal(HttpStatusCode.OK, begin.StatusCode);
                var transfer = (await begin.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("transferId").GetString()!;
                Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsJsonAsync("/v1/publications/finalize", new { schemaVersion = new { major = 1, minor = 0 }, workspaceId = workspace, transferId = transfer })).StatusCode);
                Assert.Empty((await client.GetFromJsonAsync<JsonElement>("/v1/publications?workspaceId=" + workspace)).GetProperty("snapshots").EnumerateArray());
                Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/v1/publications/blobs", new { schemaVersion = new { major = 1, minor = 0 }, workspaceId = workspace, transferId = transfer, hash = blob, bytes = Convert.ToBase64String(Encoding.UTF8.GetBytes("wrong")) })).StatusCode);
                Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsJsonAsync("/v1/publications/finalize", new { schemaVersion = new { major = 1, minor = 0 }, workspaceId = workspace, transferId = transfer })).StatusCode);
                for (var i = 0; i < 2; i++) Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/v1/publications/blobs", new { schemaVersion = new { major = 1, minor = 0 }, workspaceId = workspace, transferId = transfer, hash = blob, bytes = Convert.ToBase64String(bytes) })).StatusCode);
                for (var i = 0; i < 2; i++) Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/v1/publications/finalize", new { schemaVersion = new { major = 1, minor = 0 }, workspaceId = workspace, transferId = transfer })).StatusCode);
                Assert.Single((await client.GetFromJsonAsync<JsonElement>("/v1/publications?workspaceId=" + workspace)).GetProperty("snapshots").EnumerateArray());
                // Changing semantic content without changing the content-derived ID cannot be staged.
                var invalid = JsonSerializer.Deserialize<JsonElement>(JsonSerializer.Serialize(new { schemaVersion = new { major = 1, minor = 0 }, snapshotId = id, documentNamespace = "other", semantic.selectedRootIds, semantic.rootAliases, semantic.nodes }));
                Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/v1/publications/begin", new { schemaVersion = new { major = 1, minor = 0 }, workspaceId = workspace, snapshot = invalid })).StatusCode);
                var diagnostic = new { schemaVersion = new { major = 1, minor = 0 }, code = "UNSUPPORTED_FEATURE", severity = "error", message = "Unsupported paint" };
                var blockedSemantic = new { semantic.documentNamespace, semantic.selectedRootIds, semantic.rootAliases, semantic.nodes, extractionDiagnostics = new[] { diagnostic } };
                var blockedId = "sha256:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(Canonical(JsonDocument.Parse(JsonSerializer.Serialize(blockedSemantic)).RootElement))));
                var blocked = new { schemaVersion = new { major = 1, minor = 0 }, snapshotId = blockedId, blockedSemantic.documentNamespace, blockedSemantic.selectedRootIds, blockedSemantic.rootAliases, blockedSemantic.nodes, blockedSemantic.extractionDiagnostics };
                var blockedBegin = await client.PostAsJsonAsync("/v1/publications/begin", new { schemaVersion = new { major = 1, minor = 0 }, workspaceId = workspace, snapshot = blocked });
                Assert.Equal(HttpStatusCode.OK, blockedBegin.StatusCode);
                var blockedTransfer = (await blockedBegin.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("transferId").GetString()!;
                Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/v1/publications/blobs", new { schemaVersion = new { major = 1, minor = 0 }, workspaceId = workspace, transferId = blockedTransfer, hash = blob, bytes = Convert.ToBase64String(bytes) })).StatusCode);
                var blockedResult = await client.PostAsJsonAsync("/v1/publications/finalize", new { schemaVersion = new { major = 1, minor = 0 }, workspaceId = workspace, transferId = blockedTransfer });
                Assert.Equal("blocked", (await blockedResult.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("status").GetString());
                var expiring = await client.PostAsJsonAsync("/v1/publications/begin", new { schemaVersion = new { major = 1, minor = 0 }, workspaceId = workspace, snapshot });
                var expiredId = (await expiring.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("transferId").GetString()!;
                now = now.AddHours(2);
                Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/v1/publications/finalize", new { schemaVersion = new { major = 1, minor = 0 }, workspaceId = workspace, transferId = expiredId })).StatusCode);
                Assert.Equal(2, (await client.GetFromJsonAsync<JsonElement>("/v1/publications?workspaceId=" + workspace)).GetProperty("snapshots").GetArrayLength());
                Assert.Equal("original project", File.ReadAllText(Path.Combine(root, "game.csproj")));
                Assert.Equal("original gum", File.ReadAllText(Path.Combine(root, "ui.gumx")));
            }
            await using (var host = await PairingHost.StartAsync(0, () => now, data))
            {
                using var client = await Paired(host);
                Assert.Equal(2, (await client.GetFromJsonAsync<JsonElement>("/v1/publications?workspaceId=" + workspace)).GetProperty("snapshots").GetArrayLength());
            }
        }
        finally { Directory.Delete(data, true); }
    }
    [Fact]
    public void JavascriptUnicodeAndNumberVectorAndSequentialTransfers()
    {
        var data = Path.Combine("/private/tmp", "publication-vectors-" + Guid.NewGuid().ToString("N"));
        var workspace = new string('a', 32);
        var semantic = """{"documentNamespace":"design-1","selectedRootIds":["1:2"],"rootAliases":[{"rootId":"1:2","alias":"Main"}],"nodes":[{"id":"1:2","parentId":null,"type":"FRAME","name":"😀","x":1e-7,"y":1e-6,"width":100,"height":100,"visible":true,"layoutMode":"NONE","clipsContent":false}]}""";
        var snapshot = JsonDocument.Parse("{" + "\"schemaVersion\":{\"major\":1,\"minor\":0},\"snapshotId\":\"sha256:4f727b77f8b0ec2756d1b9378e0bcd9e9010d5a8be841f53412e7ed6fdf4cba5\"," + semantic[1..]).RootElement;
        try
        {
            var store = new GumBridge.Infrastructure.Storage.PublicationStore(data, () => DateTimeOffset.UtcNow);
            for (var i = 0; i < 34; i++)
            {
                var (transfer, missing) = store.Begin(workspace, snapshot);
                Assert.Empty(missing);
                Assert.Equal("published", store.Finalize(workspace, transfer).status);
                Assert.Equal("published", store.Finalize(workspace, transfer).status);
            }
            Assert.Single(store.List(workspace));
            var storage = Path.Combine(data, "publications", workspace, "blobs");
            Directory.CreateDirectory(storage);
            using (var quota = File.Create(Path.Combine(storage, "unreferenced-orphan"))) quota.SetLength(256L * 1024 * 1024);
            var (overQuota, _) = store.Begin(workspace, snapshot);
            Assert.Throws<ArgumentException>(() => store.Finalize(workspace, overQuota));
            Assert.False(File.Exists(Path.Combine(data, "publications", workspace, "completed", overQuota + ".json")));
            Assert.Single(store.List(workspace));
        }
        finally { if (Directory.Exists(data)) Directory.Delete(data, true); }
    }

    [Theory]
    [InlineData("sha256:c2fac1aaaf745ac8950352669ff8469dbef819432cb13ed91e3b177a4857ab55", "\\b")]
    [InlineData("sha256:edeec0425cc6a60db11184bb115f7a4b23f3ce11876532a8023f385269292974", "\\f")]
    public void JavascriptGeneratedControlCharacterSnapshotsPublish(string snapshotId, string escapedCharacter)
    {
        // IDs generated with the plugin's canonicalize/hashBytes (extraction.ts), not the C# test canonicalizer.
        var data = Path.Combine("/private/tmp", "publication-control-" + Guid.NewGuid().ToString("N"));
        var workspace = new string('a', 32);
        var json = """{"schemaVersion":{"major":1,"minor":0},"snapshotId":"SNAPSHOT_ID","documentNamespace":"design-1","selectedRootIds":["1:2"],"rootAliases":[{"rootId":"1:2","alias":"Main"}],"nodes":[{"id":"1:2","parentId":null,"type":"FRAME","name":"ScreenCONTROLTitle","x":0,"y":0,"width":100,"height":100,"visible":true,"layoutMode":"NONE","clipsContent":false},{"id":"1:3","parentId":"1:2","type":"TEXT","name":"Label","x":0,"y":0,"width":10,"height":10,"visible":true,"characters":"FirstCONTROLSecond","fontSize":12,"fontFamily":"Arial","fontStyle":"Regular"}]}"""
            .Replace("SNAPSHOT_ID", snapshotId).Replace("CONTROL", escapedCharacter);
        try
        {
            using var document = JsonDocument.Parse(json);
            var store = new GumBridge.Infrastructure.Storage.PublicationStore(data, () => DateTimeOffset.UtcNow);
            var (transfer, missing) = store.Begin(workspace, document.RootElement);
            Assert.Empty(missing);
            Assert.Equal((snapshotId, "published"), store.Finalize(workspace, transfer));
            Assert.Single(store.List(workspace));
        }
        finally { if (Directory.Exists(data)) Directory.Delete(data, true); }
    }

    [Fact]
    public void StagingBudgetRejectsDistinctBlobsBeforeWritingAndCountsReusedBlobs()
    {
        var data = Path.Combine("/private/tmp", "publication-budget-" + Guid.NewGuid().ToString("N"));
        var workspace = new string('a', 32);
        try
        {
            var store = new GumBridge.Infrastructure.Storage.PublicationStore(data, () => DateTimeOffset.UtcNow);
            var images = Enumerable.Range(0, 4).Select(i => Enumerable.Repeat((byte)(i + 1), 4 * 1024 * 1024).ToArray()).ToArray();
            var hashes = images.Select(b => "sha256:" + Convert.ToHexStringLower(SHA256.HashData(b))).ToArray();
            var nodes = new object[] { new { id = "1:2", parentId = (string?)null, type = "FRAME", name = "Main", x = 0, y = 0, width = 100, height = 100, visible = true, layoutMode = "NONE", clipsContent = false } }
                .Concat(hashes.Select((h, i) => (object)new { id = $"1:{i + 3}", parentId = "1:2", type = "IMAGE", name = "Image", x = 0, y = 0, width = 1, height = 1, visible = true, imageHash = h, scaleMode = "FIT" })).ToArray();
            var semantic = new { documentNamespace = "design-1", selectedRootIds = new[] { "1:2" }, rootAliases = new[] { new { rootId = "1:2", alias = "Main" } }, nodes };
            var json = JsonSerializer.Serialize(semantic);
            var id = "sha256:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(Canonical(JsonDocument.Parse(json).RootElement))));
            var snapshot = JsonSerializer.Deserialize<JsonElement>(JsonSerializer.Serialize(new { schemaVersion = new { major = 1, minor = 0 }, snapshotId = id, semantic.documentNamespace, semantic.selectedRootIds, semantic.rootAliases, semantic.nodes }));
            var (transfer, _) = store.Begin(workspace, snapshot);
            for (var i = 0; i < 3; i++) store.Upload(workspace, transfer, hashes[i], Convert.ToBase64String(images[i]));
            Assert.Throws<ArgumentException>(() => store.Upload(workspace, transfer, hashes[3], Convert.ToBase64String(images[3])));
            Assert.False(File.Exists(Path.Combine(data, "publications", workspace, "staging", transfer, hashes[3][7..])));
            var blobDir = Path.Combine(data, "publications", workspace, "blobs");
            Directory.CreateDirectory(blobDir);
            foreach (var i in Enumerable.Range(0, 4)) File.WriteAllBytes(Path.Combine(blobDir, hashes[i][7..]), images[i]);
            Assert.Throws<ArgumentException>(() => store.Begin(workspace, snapshot)); // reused blobs cannot evade total budget
        }
        finally { if (Directory.Exists(data)) Directory.Delete(data, true); }
    }
    private static async Task<HttpClient> Paired(PairingHost host) { await Task.CompletedTask; return new HttpClient { BaseAddress = new Uri(host.Address) }; }
    private static string Canonical(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Object => "{" + string.Join(',', value.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal).Select(p => JsonSerializer.Serialize(p.Name) + ":" + Canonical(p.Value))) + "}",
        JsonValueKind.Array => "[" + string.Join(',', value.EnumerateArray().Select(Canonical)) + "]",
        _ => value.GetRawText()
    };
}
