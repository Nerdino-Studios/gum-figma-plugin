using System;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.IO;
using System.Diagnostics;
using System.Xml.Linq;
using GumBridge.Conversion;
using GumBridge.Infrastructure.Gum;
using GumBridge.Host;
using System.Security.Cryptography;
using System.Net.Http;
using System.Net.Http.Json;
using System.Threading.Tasks;
using System.Text;
using System.Collections.Generic;
using GumBridge.Infrastructure.Storage;
using Xunit;

namespace GumBridge.Contracts.Tests;

public sealed class SharedComponentTests
{
    [Fact]
    public void ComponentLoweringPreservesApprovedShapeVersion()
    {
        var snapshot = JsonNode.Parse(Shared)!;
        snapshot["schemaVersion"]!["minor"] = 6;
        var assetHash = "sha256:" + new string('a', 64);
        snapshot["components"]![0]!["nodes"]!.AsArray().Add(JsonSerializer.SerializeToNode(new {
            id = "polygon", parentId = "button", type = "IMAGE", name = "Approved polygon", x = 1, y = 1,
            width = 1, height = 1, visible = true, imageHash = assetHash, scaleMode = "FIT",
            fallback = new { feature = "decorative-shape", fingerprint = "sha256:" + new string('b', 64) }
        }));
        using var document = JsonDocument.Parse(snapshot.ToJsonString());
        var result = MinimalConverter.Convert(document.RootElement, new Dictionary<string, (double Width, double Height)> {
            [assetHash] = (1, 1)
        });
        Assert.Empty(result.Diagnostics);
        Assert.Contains(Assert.Single(result.Components).Elements, element => element.Type == "Sprite");
    }

    private const string Shared = """
        {"schemaVersion":{"major":1,"minor":5},"snapshotId":"fixture","documentNamespace":"design",
        "selectedRootIds":["screenA","screenB"],"rootAliases":[{"rootId":"screenA","alias":"First"},{"rootId":"screenB","alias":"Second"}],
        "components":[{"id":"button","alias":"SharedButton","mode":"generate","nodes":[
          {"id":"button","parentId":null,"type":"FRAME","name":"Button","x":0,"y":0,"width":120,"height":40,"visible":true,"layoutMode":"NONE","clipsContent":false,"color":"#ff0000"}]}],
        "nodes":[
          {"id":"screenA","parentId":null,"type":"FRAME","name":"First","x":0,"y":0,"width":800,"height":600,"visible":true,"layoutMode":"NONE","clipsContent":false},
          {"id":"instanceA","parentId":"screenA","type":"INSTANCE","name":"Button A","componentId":"button","x":10,"y":20,"width":120,"height":40,"visible":true},
          {"id":"screenB","parentId":null,"type":"FRAME","name":"Second","x":0,"y":0,"width":800,"height":600,"visible":true,"layoutMode":"NONE","clipsContent":false},
          {"id":"instanceB","parentId":"screenB","type":"INSTANCE","name":"Button B","componentId":"button","x":30,"y":40,"width":120,"height":40,"visible":false}]}
        """;

    [Fact]
    public void TwoScreensReuseOneNativeComponentWithoutDuplicatingDefinition()
    {
        using var doc = JsonDocument.Parse(Shared);
        var result = MinimalConverter.Convert(doc.RootElement);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(new[] { "First", "Second" }, result.Screens.Select(s => s.Name));
        var component = Assert.Single(result.Components);
        Assert.Equal("SharedButton", component.Name);
        Assert.Contains("<ComponentSave", GumModelSerializer.SerializeComponent(component));
        foreach (var screen in result.Screens)
        {
            var instance = Assert.Single(screen.Elements);
            Assert.Equal("SharedButton", instance.Type);
            Assert.Contains("<BaseType>SharedButton</BaseType>", GumModelSerializer.Serialize(screen));
        }
        Assert.False(result.Screens[1].Elements[0].Visible);
    }

    [Fact]
    public void StagedSharedComponentLoadsThroughPinnedGumCli()
    {
        using var doc = JsonDocument.Parse(Shared);
        var result = MinimalConverter.Convert(doc.RootElement);
        var repository = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var sample = Path.Combine(repository, "samples/GumBridge.Sample/Content/GumProject");
        var stage = Path.Combine(Path.GetTempPath(), "gam223-" + Guid.NewGuid().ToString("N"));
        try
        {
            CopyTree(sample, stage);
            Directory.CreateDirectory(Path.Combine(stage, "Components"));
            Directory.CreateDirectory(Path.Combine(stage, "Screens"));
            var gumx = Path.Combine(stage, "GumProject.gumx");
            var project = XDocument.Load(gumx);
            foreach (var component in result.Components)
            {
                File.WriteAllText(Path.Combine(stage, "Components", component.Name + ".gucx"), GumModelSerializer.SerializeComponent(component));
                project.Root!.Add(new XElement("ComponentReference", new XAttribute("Name", component.Name)));
            }
            foreach (var screen in result.Screens)
            {
                File.WriteAllText(Path.Combine(stage, "Screens", screen.Name + ".gusx"), GumModelSerializer.Serialize(screen));
                project.Root!.Add(new XElement("ScreenReference", new XAttribute("Name", screen.Name)));
            }
            project.Save(gumx);
            var start = new ProcessStartInfo("dotnet") { WorkingDirectory = repository, RedirectStandardOutput = true, RedirectStandardError = true };
            start.Environment["DOTNET_ROLL_FORWARD"] = "Major";
            foreach (var screen in result.Screens)
            {
                var png = Path.Combine(stage, screen.Name + ".png");
                var args = new[] { "tool", "run", "gumcli", "--", "screenshot", gumx, screen.Name, "--output", png,
                    "--width", "800", "--height", "600", "--backend", "monogame" };
                start.ArgumentList.Clear();
                foreach (var arg in args) start.ArgumentList.Add(arg);
                using var process = Process.Start(start)!;
                var output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
                Assert.True(process.WaitForExit(60000) && process.ExitCode == 0, output);
                Assert.True(File.Exists(png));
                var point = screen.Name == "First" ? (12, 22) : (32, 42);
                var pixel = MinimalConversionTests.ReadPngPixel(File.ReadAllBytes(png), point.Item1, point.Item2);
                if (screen.Name == "First") Assert.Equal(((byte)255, (byte)0, (byte)0), pixel);
                else Assert.NotEqual(((byte)255, (byte)0, (byte)0), pixel);
            }
        }
        finally { if (Directory.Exists(stage)) Directory.Delete(stage, recursive: true); }
    }

    private static void CopyTree(string source, string target)
    {
        Directory.CreateDirectory(target);
        foreach (var file in Directory.GetFiles(source)) File.Copy(file, Path.Combine(target, Path.GetFileName(file)));
        foreach (var child in Directory.GetDirectories(source)) CopyTree(child, Path.Combine(target, Path.GetFileName(child)));
    }

    [Fact]
    public void ReferencedControlNeedsMatchingTargetHashAndIsNeverSerialized()
    {
        var hash = "sha256:" + new string('a', 64);
        var json = System.Text.Json.Nodes.JsonNode.Parse(Shared)!.AsObject();
        var component = json["components"]![0]!.AsObject();
        component["mode"] = "reference";
        component.Remove("nodes");
        component["controlId"] = "controls.button";
        component["width"] = 120; component["height"] = 40;
        using var doc = JsonDocument.Parse(json.ToJsonString());
        var blocked = MinimalConverter.Convert(doc.RootElement);
        Assert.Contains(blocked.Diagnostics, d => d.Code == "UNRESOLVED_COMPONENT");
        var allowed = MinimalConverter.Convert(doc.RootElement, referenceHashes: new System.Collections.Generic.Dictionary<string, string> { ["controls.button"] = hash },
            referenceDimensions: new Dictionary<string, (double Width, double Height)> { ["controls.button"] = (120, 40) });
        Assert.Empty(allowed.Diagnostics);
        Assert.Empty(allowed.Components);
        Assert.Equal(2, allowed.Screens.Count);
        var anotherWorkspace = MinimalConverter.Convert(doc.RootElement, referenceHashes: new System.Collections.Generic.Dictionary<string, string> { ["controls.button"] = "sha256:" + new string('b', 64) },
            referenceDimensions: new Dictionary<string, (double Width, double Height)> { ["controls.button"] = (120, 40) });
        Assert.Equal(GumModelSerializer.Serialize(allowed.Screens[0]), GumModelSerializer.Serialize(anotherWorkspace.Screens[0]));
    }

    [Fact]
    public void ReferencedInstanceResizeInHandBuiltSnapshotCannotBypassTheContract()
    {
        var json = System.Text.Json.Nodes.JsonNode.Parse(Shared)!.AsObject();
        var component = json["components"]![0]!.AsObject();
        component["mode"] = "reference"; component.Remove("nodes"); component["controlId"] = "SharedButton";
        component["width"] = 120; component["height"] = 40;
        json["nodes"]![1]!["width"] = 200;
        using var doc = JsonDocument.Parse(json.ToJsonString());
        var result = MinimalConverter.Convert(doc.RootElement, referenceHashes: new System.Collections.Generic.Dictionary<string, string> { ["SharedButton"] = "sha256:" + new string('a', 64) });
        Assert.Empty(result.Screens);
        Assert.Contains(result.Diagnostics, d => d.Code == "INVALID_CONTROL_CONTRACT" && d.NodeId == "instanceA");
    }

    [Fact]
    public void ResponsiveReferencedInstanceCannotResizeAtRuntime()
    {
        var json = System.Text.Json.Nodes.JsonNode.Parse(Shared)!.AsObject();
        var component = json["components"]![0]!.AsObject();
        component["mode"] = "reference"; component.Remove("nodes"); component["controlId"] = "SharedButton";
        component["width"] = 120; component["height"] = 40;
        json["nodes"]![1]!["horizontalSizing"] = "FILL";
        json["nodes"]![1]!["horizontalAnchor"] = "STRETCH";
        using var doc = JsonDocument.Parse(json.ToJsonString());
        Assert.False(WireContracts.Validate("snapshot", doc.RootElement));
        var result = MinimalConverter.Convert(doc.RootElement,
            referenceHashes: new Dictionary<string, string> { ["SharedButton"] = "sha256:" + new string('a', 64) },
            referenceDimensions: new Dictionary<string, (double Width, double Height)> { ["SharedButton"] = (120, 40) });
        Assert.Empty(result.Screens);
        Assert.Contains(result.Diagnostics, d => d.Code is "INVALID_CONTROL_CONTRACT" or "INVALID_SNAPSHOT");
    }

    [Fact]
    public void ReferenceCannotResizeNativeTargetDespiteMatchingFigmaPlaceholder()
    {
        var json = System.Text.Json.Nodes.JsonNode.Parse(Shared)!.AsObject();
        var component = json["components"]![0]!.AsObject();
        component["mode"] = "reference"; component.Remove("nodes"); component["controlId"] = "SharedButton";
        component["width"] = 120; component["height"] = 40;
        using var doc = JsonDocument.Parse(json.ToJsonString());
        var result = MinimalConverter.Convert(doc.RootElement,
            referenceHashes: new System.Collections.Generic.Dictionary<string, string> { ["SharedButton"] = "sha256:" + new string('a', 64) },
            referenceDimensions: new System.Collections.Generic.Dictionary<string, (double Width, double Height)> { ["SharedButton"] = (80, 20) });
        Assert.Empty(result.Screens);
        Assert.Contains(result.Diagnostics, d => d.Code == "INVALID_CONTROL_CONTRACT" && d.NodeId == "instanceA");
    }

    [Fact]
    public void ComponentGraphWithBlockingExtractionDiagnosticNeverConverts()
    {
        var json = System.Text.Json.Nodes.JsonNode.Parse(Shared)!.AsObject();
        json["extractionDiagnostics"] = System.Text.Json.Nodes.JsonNode.Parse("""
            [{"schemaVersion":{"major":1,"minor":5},"code":"UNSUPPORTED_FEATURE","severity":"error","message":"unsupported paint"}]
            """);
        using var doc = JsonDocument.Parse(json.ToJsonString());
        var result = MinimalConverter.Convert(doc.RootElement);
        Assert.Empty(result.Screens);
        Assert.Empty(result.Components);
        Assert.Contains(result.Diagnostics, d => d.Code == "UNSUPPORTED_FEATURE");
    }

    [Fact]
    public async Task PreviewStagesBothScreensWithOneSharedComponentAndReturnsFirstImage()
    {
        var data = Path.Combine(OperatingSystem.IsMacOS() ? "/private/tmp" : Path.GetTempPath(), "gam223-preview-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(data);
            var entry = new WorkspaceStore(data).Init(Path.Combine(data, "sample"));
            var snapshotNode = System.Text.Json.Nodes.JsonNode.Parse(Shared)!.AsObject();
            var document = JsonDocument.Parse(snapshotNode.ToJsonString()).RootElement;
            var semantic = "{" + string.Join(',', document.EnumerateObject().Where(p => p.Name is not ("snapshotId" or "schemaVersion"))
                .OrderBy(p => p.Name, StringComparer.Ordinal).Select(p => JsonSerializer.Serialize(p.Name) + ":" + Canonical(p.Value))) + "}";
            var id = "sha256:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(semantic)));
            snapshotNode["snapshotId"] = id;
            using var snapshot = JsonDocument.Parse(snapshotNode.ToJsonString());
            var publications = new PublicationStore(data, () => DateTimeOffset.UtcNow);
            var (transfer, missing) = publications.Begin(entry.id, snapshot.RootElement);
            Assert.Empty(missing);
            publications.Finalize(entry.id, transfer);
            var steps = new List<string>();
            Task Tool(string stage, string[] argv)
            {
                steps.Add(argv[0]);
                var gumx = Path.Combine(stage, entry.gumx);
                var project = XDocument.Load(gumx);
                Assert.Equal(new[] { "First", "Second" }, project.Root!.Elements("ScreenReference").Select(r => (string?)r.Attribute("Name")));
                Assert.Equal(1, project.Root.Elements("ComponentReference").Count(r => (string?)r.Attribute("Name") == "SharedButton"));
                Assert.True(File.Exists(Path.Combine(Path.GetDirectoryName(gumx)!, "Screens", "First.gusx")));
                Assert.True(File.Exists(Path.Combine(Path.GetDirectoryName(gumx)!, "Screens", "Second.gusx")));
                if (argv[0] == "screenshot")
                {
                    Assert.Contains("First", argv);
                    File.Copy(Path.Combine(stage, "Content", "GumProject", "ExampleSpriteFrame.png"), argv[Array.IndexOf(argv, "--output") + 1]);
                }
                return Task.CompletedTask;
            }
            var target = PreviewOperation.TargetHash(entry);
            var preview = new PreviewOperation(publications, new PreviewStore(data), Tool);
            var result = await preview.CreateAsync(entry, id, target);
            Assert.Equal(target, result.targetHash);
            Assert.Equal(new[] { "check", "fonts", "codegen", "screenshot" }, steps);
        }
        finally { if (Directory.Exists(data)) Directory.Delete(data, true); }
    }

    private static string Canonical(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Object => "{" + string.Join(',', value.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal)
            .Select(p => JsonSerializer.Serialize(p.Name) + ":" + Canonical(p.Value))) + "}",
        JsonValueKind.Array => "[" + string.Join(',', value.EnumerateArray().Select(Canonical)) + "]",
        _ => value.GetRawText()
    };

    private static string NativeControl(string name, int width, int height) =>
        $"<ComponentSave><Name>{name}</Name><BaseType>Container</BaseType><State><Name>Default</Name>" +
        $"<Variable Type=\"float\" Name=\"Width\" SetsValue=\"true\"><Value>{width}</Value></Variable>" +
        $"<Variable Type=\"float\" Name=\"Height\" SetsValue=\"true\"><Value>{height}</Value></Variable>" +
        "<Variable Type=\"DimensionUnitType\" Name=\"WidthUnits\" SetsValue=\"true\"><Value>0</Value></Variable>" +
        "<Variable Type=\"DimensionUnitType\" Name=\"HeightUnits\" SetsValue=\"true\"><Value>0</Value></Variable>" +
        "</State></ComponentSave>";

    [Fact]
    public async Task HostCatalogReturnsOnlyRegisteredReferenceHashesWithoutPaths()
    {
        var data = Path.Combine(OperatingSystem.IsMacOS() ? "/private/tmp" : Path.GetTempPath(), "gam223-catalog-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(data);
            var entry = new WorkspaceStore(data).Init(Path.Combine(data, "sample"));
            var gumx = Path.Combine(entry.root, entry.gumx);
            var project = XDocument.Load(gumx);
            project.Root!.Add(new XElement("ComponentReference", new XAttribute("Name", "ExistingButton")));
            project.Save(gumx);
            var component = Path.Combine(Path.GetDirectoryName(gumx)!, "Components", "ExistingButton.gucx");
            Directory.CreateDirectory(Path.GetDirectoryName(component)!);
            File.WriteAllText(component, NativeControl("ExistingButton", 120, 40));
            var hash = "sha256:" + Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(component)));
            await using var host = await PairingHost.StartAsync(0, localDataDirectory: data);
            using var client = new HttpClient { BaseAddress = new Uri(host.Address.Replace("127.0.0.1", "localhost")) };
            var response = await client.GetAsync("/v1/component-catalog?workspaceId=" + entry.id);
            Assert.True(response.IsSuccessStatusCode);
            using var result = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            Assert.Equal(hash, result.RootElement.GetProperty("controls")[0].GetProperty("hash").GetString());
            Assert.Equal("ExistingButton", result.RootElement.GetProperty("controls")[0].GetProperty("controlId").GetString());
            Assert.Equal(120, result.RootElement.GetProperty("controls")[0].GetProperty("width").GetDouble());
            Assert.Equal(40, result.RootElement.GetProperty("controls")[0].GetProperty("height").GetDouble());
            Assert.DoesNotContain(entry.root, result.RootElement.GetRawText());
            Assert.Equal(System.Net.HttpStatusCode.NotFound, (await client.GetAsync("/v1/component-catalog?workspaceId=" + new string('a', 32))).StatusCode);
        }
        finally { if (Directory.Exists(data)) Directory.Delete(data, true); }
    }

    [Fact]
    public void PreviewReferenceResolutionChecksRegisteredTargetBytesWithoutRewritingThem()
    {
        var root = Path.Combine(Path.GetTempPath(), "gam223-ref-" + Guid.NewGuid().ToString("N"));
        try
        {
            CopyTree(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../samples/GumBridge.Sample/Content/GumProject")), root);
            var path = Path.Combine(root, "Components", "SharedButton.gucx");
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, NativeControl("SharedButton", 120, 40));
            var expected = "sha256:" + Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(path)));
            var gumx = Path.Combine(root, "GumProject.gumx");
            var project = XDocument.Load(gumx);
            project.Root!.Add(new XElement("ComponentReference", new XAttribute("Name", "SharedButton")));
            project.Save(gumx);
            var json = System.Text.Json.Nodes.JsonNode.Parse(Shared)!.AsObject();
            var component = json["components"]![0]!.AsObject();
            component["mode"] = "reference"; component["controlId"] = "SharedButton"; component.Remove("nodes");
            component["width"] = 120; component["height"] = 40;
            using var doc = JsonDocument.Parse(json.ToJsonString());
            var workspace = new WorkspaceEntry("sample", "Sample", "sample", root, "Sample.csproj", "GumProject.gumx");
            var before = File.ReadAllBytes(path);
            var trusted = PreviewOperation.ResolveReferenceHashes(workspace, doc.RootElement);
            Assert.Equal(expected, trusted["SharedButton"]);
            Assert.Equal(2, MinimalConverter.Convert(doc.RootElement, referenceHashes: trusted,
                referenceDimensions: new Dictionary<string, (double Width, double Height)> { ["SharedButton"] = (120, 40) }).Screens.Count);
            Assert.Equal(before, File.ReadAllBytes(path));
            var targetBefore = PreviewOperation.TargetHash(workspace);
            File.WriteAllText(path, NativeControl("SharedButton", 80, 20));
            Assert.NotEqual(targetBefore, PreviewOperation.TargetHash(workspace));
            var changed = PreviewOperation.ResolveReferenceContracts(workspace, doc.RootElement);
            Assert.NotEqual(expected, changed["SharedButton"].Hash);
            Assert.Equal(80, changed["SharedButton"].Width);
            var invalid = MinimalConverter.Convert(doc.RootElement,
                referenceHashes: changed.ToDictionary(p => p.Key, p => p.Value.Hash),
                referenceDimensions: changed.ToDictionary(p => p.Key, p => (p.Value.Width, p.Value.Height)));
            Assert.Empty(invalid.Screens);
            Assert.Contains(invalid.Diagnostics, d => d.Code == "INVALID_CONTROL_CONTRACT" && d.NodeId == "instanceA");
        }
        finally { if (Directory.Exists(root)) Directory.Delete(root, true); }
    }

    [Fact]
    public void PartialRootExportKeepsItsSharedDependencyWithoutPruningOtherRoots()
    {
        var json = System.Text.Json.Nodes.JsonNode.Parse(Shared)!.AsObject();
        json["selectedRootIds"] = new System.Text.Json.Nodes.JsonArray("screenA");
        json["rootAliases"] = new System.Text.Json.Nodes.JsonArray(new System.Text.Json.Nodes.JsonObject { ["rootId"] = "screenA", ["alias"] = "First" });
        var nodes = json["nodes"]!.AsArray();
        nodes.RemoveAt(3); nodes.RemoveAt(2);
        using var doc = JsonDocument.Parse(json.ToJsonString());
        var result = MinimalConverter.Convert(doc.RootElement);
        Assert.Empty(result.Diagnostics);
        Assert.Single(result.Screens);
        Assert.Single(result.Components);
        Assert.Equal("SharedButton", result.Screens[0].Elements.Single().Type);
    }

    [Fact]
    public void ChangingInstanceSizeIsBlockedUntilNativeDefinitionCanResize()
    {
        using var doc = JsonDocument.Parse(Shared.Replace("\"id\":\"instanceA\",\"parentId\":\"screenA\",\"type\":\"INSTANCE\",\"name\":\"Button A\",\"componentId\":\"button\",\"x\":10,\"y\":20,\"width\":120", "\"id\":\"instanceA\",\"parentId\":\"screenA\",\"type\":\"INSTANCE\",\"name\":\"Button A\",\"componentId\":\"button\",\"x\":10,\"y\":20,\"width\":200", StringComparison.Ordinal));
        var result = MinimalConverter.Convert(doc.RootElement);
        Assert.Empty(result.Screens);
        Assert.Empty(result.Components);
        Assert.Contains(result.Diagnostics, d => d.Code == "INVALID_CONTROL_CONTRACT" && d.NodeId == "instanceA");
    }

    [Fact]
    public void CyclicDependencyCannotEmitPartialOutput()
    {
        var json = System.Text.Json.Nodes.JsonNode.Parse(Shared)!.AsObject();
        json["components"]![0]!["nodes"]!.AsArray().Add(new System.Text.Json.Nodes.JsonObject {
            ["id"] = "recursive", ["parentId"] = "button", ["type"] = "INSTANCE", ["name"] = "Recursive",
            ["componentId"] = "button", ["x"] = 0, ["y"] = 0, ["width"] = 120, ["height"] = 40, ["visible"] = true });
        using var doc = JsonDocument.Parse(json.ToJsonString());
        var result = MinimalConverter.Convert(doc.RootElement);
        Assert.Empty(result.Screens);
        Assert.Empty(result.Components);
        Assert.Contains(result.Diagnostics, d => d.Code == "UNRESOLVED_COMPONENT" && d.Message.Contains("cycle", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("\"componentId\":\"button\"", "\"componentId\":\"missing\"", "UNRESOLVED_COMPONENT")]
    [InlineData("\"alias\":\"SharedButton\"", "\"alias\":\"../Escape\"", "INVALID_CONTROL_CONTRACT")]
    [InlineData("\"width\":120,\"height\":40,\"visible\":true}", "\"width\":120,\"height\":40,\"visible\":true,\"overrides\":{\"Text\":\"unsafe\"}}", "INVALID_CONTROL_CONTRACT")]
    public void InvalidDependenciesAndOverridesBlockAllOutput(string before, string after, string code)
    {
        using var doc = JsonDocument.Parse(Shared.Replace(before, after, StringComparison.Ordinal));
        var result = MinimalConverter.Convert(doc.RootElement);
        Assert.Empty(result.Screens);
        Assert.Empty(result.Components);
        Assert.Contains(result.Diagnostics, d => d.Code == code || d.Code == "INVALID_SNAPSHOT");
    }
}
