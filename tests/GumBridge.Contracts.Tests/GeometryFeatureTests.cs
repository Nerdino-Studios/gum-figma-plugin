using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Xml.Linq;
using GumBridge.Infrastructure.Gum;
using System.Text.Json;
using GumBridge.Conversion;
using Xunit;

namespace GumBridge.Contracts.Tests;

public sealed class GeometryFeatureTests
{
    private const string Hash = "sha256:55402597b0967d51bad953e5f7d480e6b4773bd155d39e6ecf36da9404c5503f";
    private static readonly Dictionary<string, (double Width, double Height)> Images = new() { [Hash] = (24, 24) };
    private static string Snapshot(string children, bool clip = false) => $$"""
        {"schemaVersion":{"major":1,"minor":3},"snapshotId":"fixture","documentNamespace":"test",
        "selectedRootIds":["root"],"rootAliases":[{"rootId":"root","alias":"Geometry"}],
        "nodes":[{"id":"root","parentId":null,"type":"FRAME","name":"Root","x":0,"y":0,"width":200,"height":100,"visible":true,"layoutMode":"NONE","clipsContent":false},
        {"id":"box","parentId":"root","type":"FRAME","name":"Box","x":10,"y":10,"width":40,"height":40,"visible":true,"layoutMode":"NONE","clipsContent":{{clip.ToString().ToLowerInvariant()}}}{{children}}]}
        """;

    [Fact]
    public void NestedFrameClipsChildrenInNativeModel()
    {
        using var json = JsonDocument.Parse(Snapshot(""",{"id":"child","parentId":"box","type":"FRAME","name":"Child","x":30,"y":0,"width":30,"height":30,"visible":true,"layoutMode":"NONE","clipsContent":false,"color":"#ff0000"}""", true));
        var result = MinimalConverter.Convert(json.RootElement, Images);
        Assert.Empty(result.Diagnostics);
        var box = result.Screens.Single().Elements.Single(e => e.Name == "N1");
        Assert.Contains(box.Values, v => v.Name == "ClipsChildren" && v.Value == "true");
        Assert.Equal("N1", result.Screens.Single().Elements.Single(e => e.Name == "N2").Parent);
    }

    [Theory]
    [InlineData("FIT")]
    [InlineData("FILL")]
    public void ImageAspectMismatchHasExplicitNativeGeometry(string mode)
    {
        using var json = JsonDocument.Parse(Snapshot($",{{\"id\":\"image\",\"parentId\":\"box\",\"type\":\"IMAGE\",\"name\":\"Image\",\"x\":0,\"y\":0,\"width\":40,\"height\":20,\"visible\":true,\"imageHash\":\"{Hash}\",\"scaleMode\":\"{mode}\"}}"));
        var result = MinimalConverter.Convert(json.RootElement, Images);
        Assert.Empty(result.Diagnostics);
        var elements = result.Screens.Single().Elements;
        Assert.Contains(elements, e => e.Type == "Sprite" && e.Values.Any(v => v.Name == "SourceFile"));
        Assert.Contains(elements, e => e.Type == "Container" && e.Values.Any(v => v.Name == "ClipsChildren" && v.Value == "true") == (mode == "FILL"));
    }

    [Fact]
    public void ClippedChildRendersInsideOnlyAtTwoViewportSizes()
    {
        using var json = JsonDocument.Parse(Snapshot(""",{"id":"child","parentId":"box","type":"FRAME","name":"Child","x":30,"y":0,"width":30,"height":30,"visible":true,"layoutMode":"NONE","clipsContent":false,"color":"#ff0000"},{"id":"rotated","parentId":"root","type":"FRAME","name":"Rotated","x":100,"y":30,"width":30,"height":10,"visible":true,"layoutMode":"NONE","clipsContent":false,"color":"#00ff00","rotation":90}""", true));
        var repository = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var sample = Path.Combine(repository, "samples/GumBridge.Sample/Content/GumProject");
        var stage = Path.Combine(Path.GetTempPath(), "gam220-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(Path.Combine(stage, "Screens"));
            Directory.CreateDirectory(Path.Combine(stage, "Standards"));
            foreach (var file in Directory.GetFiles(Path.Combine(sample, "Standards"))) File.Copy(file, Path.Combine(stage, "Standards", Path.GetFileName(file)));
            File.Copy(Path.Combine(sample, "GumProject.gumx"), Path.Combine(stage, "GumProject.gumx"));
            File.Copy(Path.Combine(sample, "Screens/Preview.gusx"), Path.Combine(stage, "Screens/Preview.gusx"));
            var screen = Assert.Single(MinimalConverter.Convert(json.RootElement, Images).Screens);
            File.WriteAllText(Path.Combine(stage, "Screens/Geometry.gusx"), GumModelSerializer.Serialize(screen));
            var project = XDocument.Load(Path.Combine(stage, "GumProject.gumx"));
            project.Root!.Add(new XElement("ScreenReference", new XAttribute("Name", "Geometry")));
            project.Save(Path.Combine(stage, "GumProject.gumx"));
            foreach (var (width, height) in new[] { (1280, 720), (1024, 768) })
            {
                var png = Path.Combine(stage, $"clip-{width}.png");
                var start = new ProcessStartInfo("dotnet") { WorkingDirectory = repository, RedirectStandardOutput = true, RedirectStandardError = true };
                start.Environment["DOTNET_ROLL_FORWARD"] = "Major";
                foreach (var arg in new[] { "tool", "run", "gumcli", "--", "screenshot", Path.Combine(stage, "GumProject.gumx"), "Geometry", "--output", png,
                    "--width", width.ToString(), "--height", height.ToString(), "--backend", "monogame" }) start.ArgumentList.Add(arg);
                using var process = Process.Start(start)!;
                var output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
                Assert.True(process.WaitForExit(60000) && process.ExitCode == 0, output);
                var bytes = File.ReadAllBytes(png);
                Assert.Equal(((byte)255, (byte)0, (byte)0), MinimalConversionTests.ReadPngPixel(bytes, 43, 15));
                Assert.NotEqual(((byte)255, (byte)0, (byte)0), MinimalConversionTests.ReadPngPixel(bytes, 55, 15));
                Assert.Equal(((byte)0, (byte)255, (byte)0), MinimalConversionTests.ReadPngPixel(bytes, 105, 12));
                Assert.NotEqual(((byte)0, (byte)255, (byte)0), MinimalConversionTests.ReadPngPixel(bytes, 125, 35));
            }
        }
        finally { if (Directory.Exists(stage)) Directory.Delete(stage, true); }
    }

    [Fact]
    public void FigmaCounterclockwiseRotationKeepsNativeAngle()
    {
        using var json = JsonDocument.Parse(Snapshot(""",{"id":"leaf","parentId":"box","type":"FRAME","name":"Leaf","x":5,"y":5,"width":10,"height":20,"visible":true,"layoutMode":"NONE","clipsContent":false,"color":"#ff0000","rotation":30}"""));
        var result = MinimalConverter.Convert(json.RootElement, Images);
        Assert.Empty(result.Diagnostics);
        Assert.Contains(result.Screens.Single().Elements.Single(e => e.Name == "N2").Values,
            v => v.Name == "Rotation" && v.Value == "30");
    }

    [Fact]
    public void AxisAlignedCropMapsToNativeSourceRectangle()
    {
        var image = $$""",{"id":"image","parentId":"box","type":"IMAGE","name":"Crop","x":0,"y":0,"width":40,"height":20,"visible":true,"imageHash":"{{Hash}}","scaleMode":"CROP","imageTransform":[[0.5,0,0.25],[0,0.25,0.25]]}""";
        using var json = JsonDocument.Parse(Snapshot(image));
        var result = MinimalConverter.Convert(json.RootElement, Images);
        Assert.Empty(result.Diagnostics);
        var sprite = result.Screens.Single().Elements.Single(e => e.Type == "Sprite");
        Assert.Contains(sprite.Values, v => v.Name == "TextureAddress" && v.Value == "1");
        Assert.Contains(sprite.Values, v => v.Name == "TextureLeft" && v.Value == "6");
        Assert.Contains(sprite.Values, v => v.Name == "TextureTop" && v.Value == "6");
        Assert.Contains(sprite.Values, v => v.Name == "TextureWidth" && v.Value == "12");
        Assert.Contains(sprite.Values, v => v.Name == "TextureHeight" && v.Value == "6");
    }

    [Fact]
    public void FitFillAndCropRenderNativeImageAtBothViewports()
    {
        string Image(string id, int x, string mode, string extra = "") =>
            $",{{\"id\":\"{id}\",\"parentId\":\"box\",\"type\":\"IMAGE\",\"name\":\"{id}\",\"x\":{x},\"y\":0,\"width\":40,\"height\":20,\"visible\":true,\"imageHash\":\"{Hash}\",\"scaleMode\":\"{mode}\"{extra}}}";
        using var json = JsonDocument.Parse(Snapshot(Image("fit", 0, "FIT") + Image("fill", 50, "FILL") +
            Image("crop", 100, "CROP", ",\"imageTransform\":[[0.5,0,0.25],[0,0.25,0.25]]")));
        var repository = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var sample = Path.Combine(repository, "samples/GumBridge.Sample/Content/GumProject");
        var stage = Path.Combine(Path.GetTempPath(), "gam220-images-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(Path.Combine(stage, "Screens"));
            Directory.CreateDirectory(Path.Combine(stage, "Standards"));
            Directory.CreateDirectory(Path.Combine(stage, "Assets/Images"));
            foreach (var file in Directory.GetFiles(Path.Combine(sample, "Standards"))) File.Copy(file, Path.Combine(stage, "Standards", Path.GetFileName(file)));
            File.Copy(Path.Combine(sample, "GumProject.gumx"), Path.Combine(stage, "GumProject.gumx"));
            File.Copy(Path.Combine(sample, "Screens/Preview.gusx"), Path.Combine(stage, "Screens/Preview.gusx"));
            File.Copy(Path.Combine(sample, "ExampleSpriteFrame.png"), Path.Combine(stage, "Assets/Images", Hash[7..] + ".png"));
            File.WriteAllText(Path.Combine(stage, "Screens/Geometry.gusx"), GumModelSerializer.Serialize(Assert.Single(MinimalConverter.Convert(json.RootElement, Images).Screens)));
            var project = XDocument.Load(Path.Combine(stage, "GumProject.gumx"));
            project.Root!.Add(new XElement("ScreenReference", new XAttribute("Name", "Geometry")));
            project.Save(Path.Combine(stage, "GumProject.gumx"));
            foreach (var (width, height) in new[] { (1280, 720), (1024, 768) })
            {
                var png = Path.Combine(stage, $"images-{width}.png");
                var start = new ProcessStartInfo("dotnet") { WorkingDirectory = repository, RedirectStandardOutput = true, RedirectStandardError = true };
                start.Environment["DOTNET_ROLL_FORWARD"] = "Major";
                foreach (var arg in new[] { "tool", "run", "gumcli", "--", "screenshot", Path.Combine(stage, "GumProject.gumx"), "Geometry", "--output", png,
                    "--width", width.ToString(), "--height", height.ToString(), "--backend", "monogame" }) start.ArgumentList.Add(arg);
                using var process = Process.Start(start)!;
                var output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
                Assert.True(process.WaitForExit(60000) && process.ExitCode == 0, output);
                var bytes = File.ReadAllBytes(png);
                // Figma FIT letterboxes; FILL fills and clips; CROP reads the center source rectangle.
                Assert.NotEqual(((byte)255, (byte)255, (byte)255), MinimalConversionTests.ReadPngPixel(bytes, 12, 20));
                foreach (var x in new[] { 30, 80, 130 })
                    Assert.True(MinimalConversionTests.ReadPngPixel(bytes, x, 20) == ((byte)255, (byte)255, (byte)255),
                        $"{width} image at {x},20 was {MinimalConversionTests.ReadPngPixel(bytes, x, 20)}");
            }
        }
        finally { if (Directory.Exists(stage)) Directory.Delete(stage, true); }
    }

    [Theory]
    [InlineData("[[0.5,0.1,0.25],[0,0.25,0.25]]")]
    [InlineData("[[0.5,0,0.75],[0,0.25,0.25]]")]
    [InlineData("[[0.5,0,0.251],[0,0.25,0.25]]")]
    public void UnsupportedCropIsDiagnosedWithoutOutput(string matrix)
    {
        var image = $",{{\"id\":\"image\",\"parentId\":\"box\",\"type\":\"IMAGE\",\"name\":\"Crop\",\"x\":0,\"y\":0,\"width\":40,\"height\":20,\"visible\":true,\"imageHash\":\"{Hash}\",\"scaleMode\":\"CROP\",\"imageTransform\":{matrix}}}";
        using var json = JsonDocument.Parse(Snapshot(image));
        var result = MinimalConverter.Convert(json.RootElement, Images);
        Assert.Empty(result.Screens);
        Assert.Contains(result.Diagnostics, d => d.NodeId == "image" && d.Code == "UNSUPPORTED_FEATURE");
    }

    [Fact]
    public void InteractiveOrSkewedGeometryBlocksInsteadOfFlattening()
    {
        using var json = JsonDocument.Parse(Snapshot(""",{"id":"child","parentId":"box","type":"TEXT","name":"Button label","x":0,"y":0,"width":20,"height":24,"visible":true,"characters":"OK","fontFamily":"Arial","fontStyle":"Regular","fontSize":24}""").Replace("\"clipsContent\":false}", "\"clipsContent\":false,\"rotation\":15}", StringComparison.Ordinal));
        var result = MinimalConverter.Convert(json.RootElement, Images);
        Assert.Empty(result.Screens);
        Assert.Contains(result.Diagnostics, d => d.NodeId == "box" && d.Code == "UNSUPPORTED_FEATURE");
    }
}
