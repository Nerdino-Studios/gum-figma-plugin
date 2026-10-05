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
using GumBridge.Infrastructure.Gum;
using GumBridge.Infrastructure.Storage;
using Xunit;

namespace GumBridge.Contracts.Tests;

public sealed class RuntimeTests
{
    private static string Publish(string data, string workspace, int width = 800, bool shared = false)
    {
        var png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==");
        var assetHash = "sha256:" + Convert.ToHexStringLower(SHA256.HashData(png));
        var components = shared ? """
            "components":[{"alias":"SharedPanel","id":"component","mode":"generate","nodes":[
              {"clipsContent":false,"color":"#ff9900","height":80,"id":"component","layoutMode":"NONE","name":"Panel","parentId":null,"type":"FRAME","visible":true,"width":200,"x":0,"y":0}]}],
            """.Replace("\n", "").Replace("\r", "") : "";
        var instance = shared ? """
            ,{"componentId":"component","height":80,"id":"instance","name":"Panel instance","parentId":"1:2","type":"INSTANCE","visible":true,"width":200,"x":40,"y":40}
            """ : "";
        var shapes = shared ? $$$"""
            ,{"id":"decoration","parentId":"1:2","type":"IMAGE","name":"Approved polygon PNG","x":280,"y":40,"width":1,"height":1,"visible":true,"imageHash":"{{{assetHash}}}","scaleMode":"FIT","fallback":{"feature":"decorative-shape","fingerprint":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}},
            {"id":"rectangle","parentId":"1:2","type":"FRAME","name":"Native solid rectangle","x":280,"y":60,"width":100,"height":60,"visible":true,"layoutMode":"NONE","clipsContent":false,"color":"#00ff00"}
            """ : "";
        var semantic = $$"""
            {{{components}}"documentNamespace":"runtime-test","nodes":[{"clipsContent":false,"color":"#2266cc","height":600,"id":"1:2","layoutMode":"NONE","name":"Design","parentId":null,"type":"FRAME","visible":true,"width":{{width}},"x":0,"y":0}{{instance}}{{shapes}}],"rootAliases":[{"alias":"MainMenu","rootId":"1:2"}],"selectedRootIds":["1:2"]}
            """;
        using var semanticDocument = JsonDocument.Parse(semantic);
        semantic = Canonical(semanticDocument.RootElement);
        var id = "sha256:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(semantic)));
        using var document = JsonDocument.Parse("{\"schemaVersion\":{\"major\":1,\"minor\":" + (shared ? 6 : 5) + "},\"snapshotId\":\"" + id + "\"," + semantic[1..]);
        var store = new PublicationStore(data, () => DateTimeOffset.UtcNow);
        var transfer = store.Begin(workspace, document.RootElement);
        if (shared) store.Upload(workspace, transfer.transferId, assetHash, Convert.ToBase64String(png));
        store.Finalize(workspace, transfer.transferId);
        return id;
    }
    private static string Canonical(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Object => "{" + string.Join(',', value.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal)
            .Select(p => JsonSerializer.Serialize(p.Name) + ":" + Canonical(p.Value))) + "}",
        JsonValueKind.Array => "[" + string.Join(',', value.EnumerateArray().Select(Canonical)) + "]",
        _ => value.GetRawText()
    };
    private sealed class Session : IRuntimeSession
    {
        public bool IsRunning { get; private set; } = true;
        public Task DisposeAsync() { IsRunning = false; return Task.CompletedTask; }
    }

    [Fact]
    public async Task PublishedScreenRunsInRealFrb2WithoutTargetWrites()
    {
        var root = Path.Combine(OperatingSystem.IsMacOS() ? "/private/tmp" : Path.GetTempPath(), "gumbridge-frb2-smoke-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var data = Path.Combine(root, "data"); Directory.CreateDirectory(data);
            var entry = new WorkspaceStore(data).Init(Path.Combine(root, "sample"));
            var before = Directory.GetFiles(entry.root, "*", SearchOption.AllDirectories).ToDictionary(path => path, File.ReadAllBytes);
            var snapshot = Publish(data, entry.id, shared: true);
            string? stage = null;
            await using (var host = await PairingHost.StartAsync(0, localDataDirectory: data,
                runtimeLauncher: async prepared => {
                    stage = prepared.Stage;
                    return await FrbRuntimeLauncher.LaunchAsync(prepared.Stage, prepared.ScreenName, prepared.SnapshotId);
                }))
            {
                using var client = new HttpClient { BaseAddress = new Uri(host.Address), Timeout = TimeSpan.FromMinutes(4) };
                var response = await client.PostAsJsonAsync("/v1/runs", new { schemaVersion = new { major = 1, minor = 0 },
                    workspaceId = entry.id, snapshotId = snapshot, targetHash = RuntimeOperation.TargetHash(entry) });
                var body = await response.Content.ReadAsStringAsync();
                Assert.True(response.IsSuccessStatusCode, body);
                using var receipt = JsonDocument.Parse(body);
                Assert.Equal("running", receipt.RootElement.GetProperty("status").GetString());
                using var ready = JsonDocument.Parse(File.ReadAllText(Path.Combine(stage!, "runtime.ready")));
                Assert.Equal(snapshot, ready.RootElement.GetProperty("SnapshotId").GetString());
                Assert.Equal("MainMenu", ready.RootElement.GetProperty("ScreenName").GetString());
                Assert.Equal(800, ready.RootElement.GetProperty("Width").GetInt32());
                Assert.True(Directory.GetFiles(Path.Combine(stage!, "PreviewGenerated"), "*.cs", SearchOption.AllDirectories).Length >= 2);
                Assert.True(File.Exists(Path.Combine(Path.GetDirectoryName(Path.Combine(stage!, entry.gumx))!, "Components", "SharedPanel.gucx")));
                Assert.False(File.Exists(Path.Combine(stage!, "result.png")));
                foreach (var (path, bytes) in before) Assert.Equal(bytes, File.ReadAllBytes(path));
                Assert.Equal(before.Count, Directory.GetFiles(entry.root, "*", SearchOption.AllDirectories).Length);
            }
            Assert.False(Directory.Exists(stage));
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public async Task RuntimeStagesAndReusesExactSnapshotWithoutScreenshotsOrTargetWrites()
    {
        var root = Path.Combine(OperatingSystem.IsMacOS() ? "/private/tmp" : Path.GetTempPath(), "gumbridge-runtime-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var data = Path.Combine(root, "data"); Directory.CreateDirectory(data);
            var entry = new WorkspaceStore(data).Init(Path.Combine(root, "sample"));
            File.WriteAllText(Path.Combine(entry.root, "Controller.cs"), "handwritten behavior");
            var before = Directory.GetFiles(entry.root, "*", SearchOption.AllDirectories).ToDictionary(path => path, File.ReadAllBytes);
            var snapshot = Publish(data, entry.id);
            var toolSteps = new System.Collections.Generic.List<string>();
            var launches = 0; string? stage = null; var session = new Session();
            await using (var host = await PairingHost.StartAsync(0, localDataDirectory: data,
                previewToolRunner: (directory, arguments) => { toolSteps.Add(arguments[0]); return Task.CompletedTask; },
                runtimeLauncher: prepared => {
                    launches++; stage = prepared.Stage;
                    Assert.True(File.Exists(Path.Combine(Path.GetDirectoryName(prepared.GumProject)!, "Screens", "MainMenu.gusx")));
                    Assert.Equal(snapshot, prepared.SnapshotId);
                    return Task.FromResult<IRuntimeSession>(session);
                }))
            {
                using var client = new HttpClient { BaseAddress = new Uri(host.Address) };
                var targetResponse = await client.GetAsync("/v1/runtime-target?workspaceId=" + entry.id);
                Assert.Equal(HttpStatusCode.OK, targetResponse.StatusCode);
                var target = (await targetResponse.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("targetHash").GetString();
                var request = new { schemaVersion = new { major = 1, minor = 0 }, workspaceId = entry.id, snapshotId = snapshot, targetHash = target };
                var first = await client.PostAsJsonAsync("/v1/runs", request);
                Assert.Equal(HttpStatusCode.OK, first.StatusCode);
                var receipt = await first.Content.ReadFromJsonAsync<JsonElement>();
                Assert.Equal("running", receipt.GetProperty("status").GetString());
                Assert.Equal(snapshot, receipt.GetProperty("snapshotId").GetString());
                Assert.Equal(target, receipt.GetProperty("targetHash").GetString());
                var repeated = await client.PostAsJsonAsync("/v1/runs", request);
                Assert.Equal(HttpStatusCode.OK, repeated.StatusCode);
                Assert.Equal(receipt.GetProperty("runtimeId").GetString(), (await repeated.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("runtimeId").GetString());
                Assert.Equal(1, launches);
                Assert.Equal(new[] { "check", "fonts", "codegen" }, toolSteps);
                foreach (var (path, bytes) in before) Assert.Equal(bytes, File.ReadAllBytes(path));
                Assert.Equal(before.Count, Directory.GetFiles(entry.root, "*", SearchOption.AllDirectories).Length);
                File.WriteAllText(Path.Combine(entry.root, "drift.txt"), "target changed");
                Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsJsonAsync("/v1/runs", request)).StatusCode);
                Assert.True(session.IsRunning);
                Assert.Equal(1, launches);
                var hostile = await client.PostAsJsonAsync("/v1/runs", new { request.schemaVersion, request.workspaceId, request.snapshotId, request.targetHash, command = "echo hostile" });
                Assert.Equal(HttpStatusCode.BadRequest, hostile.StatusCode);
            }
            Assert.False(session.IsRunning);
            Assert.False(Directory.Exists(stage));
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public async Task FailedReplacementKeepsLastGoodRuntimeAndRemovesFailedStaging()
    {
        var root = Path.Combine(OperatingSystem.IsMacOS() ? "/private/tmp" : Path.GetTempPath(), "gumbridge-runtime-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var data = Path.Combine(root, "data"); Directory.CreateDirectory(data);
            var entry = new WorkspaceStore(data).Init(Path.Combine(root, "sample"));
            var firstId = Publish(data, entry.id); var secondId = Publish(data, entry.id, 1024);
            var session = new Session(); string? failedStage = null;
            await using var host = await PairingHost.StartAsync(0, localDataDirectory: data,
                previewToolRunner: (_, _) => Task.CompletedTask,
                runtimeLauncher: prepared => {
                    if (prepared.SnapshotId == firstId) return Task.FromResult<IRuntimeSession>(session);
                    failedStage = prepared.Stage; throw new InvalidOperationException("FRB2_START_FAILED");
                });
            using var client = new HttpClient { BaseAddress = new Uri(host.Address) };
            var target = RuntimeOperation.TargetHash(entry);
            object Request(string id) => new { schemaVersion = new { major = 1, minor = 0 }, workspaceId = entry.id, snapshotId = id, targetHash = target };
            Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/v1/runs", Request(firstId))).StatusCode);
            var failed = await client.PostAsJsonAsync("/v1/runs", Request(secondId));
            Assert.Equal(HttpStatusCode.Conflict, failed.StatusCode);
            Assert.Contains("FRB2_START_FAILED", await failed.Content.ReadAsStringAsync());
            Assert.False(Directory.Exists(failedStage));
            Assert.True(session.IsRunning);
            Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/v1/runs", Request(firstId))).StatusCode);
        }
        finally { Directory.Delete(root, true); }
    }
}
