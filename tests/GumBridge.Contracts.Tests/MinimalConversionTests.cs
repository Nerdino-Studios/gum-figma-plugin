using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Xml.Linq;
using System.Text.Json;
using GumBridge.Conversion;
using GumBridge.Infrastructure.Gum;
using Xunit;

namespace GumBridge.Contracts.Tests;

public sealed class MinimalConversionTests
{
    private const string Snapshot = """
        {"schemaVersion":{"major":1,"minor":0},"snapshotId":"fixture","documentNamespace":"sample",
        "selectedRootIds":["root"],"rootAliases":[{"rootId":"root","alias":"Golden"}],
        "nodes":[
          {"id":"root","parentId":null,"type":"FRAME","name":"Screen","x":0,"y":0,"width":800,"height":600,"visible":true,"layoutMode":"NONE","clipsContent":false,"color":"#224466"},
          {"id":"group","parentId":"root","type":"FRAME","name":"Group","x":10,"y":20,"width":200,"height":100,"visible":false,"layoutMode":"NONE","clipsContent":false},
          {"id":"label","parentId":"group","type":"TEXT","name":"Label","x":3,"y":4,"width":100,"height":24,"visible":true,"characters":"Hi & <Gum>","fontFamily":"Arial","fontStyle":"Regular","fontSize":24},
          {"id":"image","parentId":"root","type":"IMAGE","name":"Logo","x":40,"y":50,"width":64,"height":64,"visible":true,"imageHash":"sha256:55402597b0967d51bad953e5f7d480e6b4773bd155d39e6ecf36da9404c5503f","scaleMode":"FILL"}
        ]}
        """;

    private static readonly System.Collections.Generic.Dictionary<string, (double Width, double Height)> Assets = new()
    {
        ["sha256:55402597b0967d51bad953e5f7d480e6b4773bd155d39e6ecf36da9404c5503f"] = (24, 24)
    };

    [Fact]
    public void GoldenFrameTextImageIsStableAndNative()
    {
        using var doc = JsonDocument.Parse(Snapshot);
        var result = MinimalConverter.Convert(doc.RootElement, Assets);
        Assert.Empty(result.Diagnostics);
        var screen = Assert.Single(result.Screens);
        Assert.Equal("Golden", screen.Name);
        Assert.Equal(new[] { "N0_Background", "N1", "N2", "N3" }, screen.Elements.Select(e => e.Name));
        Assert.Equal("N1", screen.Elements[2].Parent);
        Assert.False(screen.Elements[1].Visible);
        var first = GumModelSerializer.Serialize(screen);
        Assert.Equal(first, GumModelSerializer.Serialize(MinimalConverter.Convert(doc.RootElement, Assets).Screens[0]));
        Assert.Equal("068ab56806fc776dd29a1b40b32a3ae9bfe9afb213e74e69d8652ce3953fc086", Convert.ToHexStringLower(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(first))));
        Assert.Contains("Hi &amp; &lt;Gum&gt;", first);
        Assert.Equal("Assets/Images/55402597b0967d51bad953e5f7d480e6b4773bd155d39e6ecf36da9404c5503f.png",
            screen.Elements[3].Values.Single(v => v.Name == "SourceFile").Value);
        Assert.Contains("N3.SourceFile", first);
        Assert.Contains("N3.TextureAddress", first);
        Assert.Contains("N1.Visible", first);
        Assert.Contains("N0_Background.FillRed", first);
    }

    [Fact]
    public void NonzeroCanvasRootKeepsBackgroundAtScreenOrigin()
    {
        using var doc = JsonDocument.Parse(Snapshot.Replace("\"x\":0,\"y\":0,\"width\":800", "\"x\":137,\"y\":251,\"width\":800", StringComparison.Ordinal));
        var screen = Assert.Single(MinimalConverter.Convert(doc.RootElement, Assets).Screens);
        var background = screen.Elements[0];
        Assert.Equal("0", background.Values.Single(v => v.Name == "X").Value);
        Assert.Equal("0", background.Values.Single(v => v.Name == "Y").Value);
        Assert.Equal("10", screen.Elements[1].Values.Single(v => v.Name == "X").Value);
        Assert.Equal("40", screen.Elements[3].Values.Single(v => v.Name == "X").Value);
    }

    [Fact]
    public void GoldenScreenLoadsInPinnedGumCliFromIsolatedStaging()
    {
        var repository = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var sample = Path.Combine(repository, "samples/GumBridge.Sample/Content/GumProject");
        var stage = Path.Combine(Path.GetTempPath(), "gam213-" + Guid.NewGuid().ToString("N"));
        try
        {
            CopyDirectory(sample, stage);
            var asset = File.ReadAllBytes(Path.Combine(sample, "ExampleSpriteFrame.png"));
            var hash = Convert.ToHexStringLower(SHA256.HashData(asset));
            Assert.Equal("55402597b0967d51bad953e5f7d480e6b4773bd155d39e6ecf36da9404c5503f", hash);
            Directory.CreateDirectory(Path.Combine(stage, "Assets/Images"));
            File.WriteAllBytes(Path.Combine(stage, "Assets/Images", hash + ".png"), asset);
            using var doc = JsonDocument.Parse(Snapshot);
            File.WriteAllText(Path.Combine(stage, "Screens/Golden.gusx"), GumModelSerializer.Serialize(Assert.Single(MinimalConverter.Convert(doc.RootElement, Assets).Screens)));
            var project = XDocument.Load(Path.Combine(stage, "GumProject.gumx"));
            project.Root!.Add(new XElement("ScreenReference", new XAttribute("Name", "Golden")));
            project.Save(Path.Combine(stage, "GumProject.gumx"));
            var gumx = Path.Combine(stage, "GumProject.gumx");
            RunGumCli(repository, "check", gumx);
            var screenshot = Path.Combine(stage, "golden.png");
            RunGumCli(repository, "screenshot", gumx, "Golden", "--output", screenshot, "--width", "800", "--height", "600", "--backend", "monogame");
            // Check a pixel within the sprite but outside the background. A successful `check` alone
            // does not prove Gum resolved SourceFile relative to the project directory.
            var imagePixel = ReadPngPixel(asset, 12, 12);
            var rendered = File.ReadAllBytes(screenshot);
            Assert.NotEqual(ReadPngPixel(rendered, 2, 2), imagePixel);
            Assert.Equal(imagePixel, ReadPngPixel(rendered, 52, 62));
        }
        finally { if (Directory.Exists(stage)) Directory.Delete(stage, recursive: true); }
    }

    private static void RunGumCli(string repository, params string[] arguments)
    {
        var start = new ProcessStartInfo("dotnet") { WorkingDirectory = repository, RedirectStandardOutput = true, RedirectStandardError = true };
        start.Environment["DOTNET_ROLL_FORWARD"] = "Major";
        foreach (var arg in new[] { "tool", "run", "gumcli", "--" }.Concat(arguments)) start.ArgumentList.Add(arg);
        using var process = Process.Start(start)!;
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(60000) && process.ExitCode == 0, stdout + stderr);
    }

    internal static (byte R, byte G, byte B) ReadPngPixel(byte[] png, int x, int y)
    {
        static int U32(byte[] b, int offset) => (int)System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(b.AsSpan(offset, 4));
        Assert.Equal(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }, png[..8]);
        var width = U32(png, 16);
        var height = U32(png, 20);
        Assert.InRange(x, 0, width - 1);
        Assert.InRange(y, 0, height - 1);
        Assert.Equal((byte)8, png[24]);
        Assert.Equal((byte)0, png[28]); // non-interlaced
        var bytesPerPixel = png[25] == 6 ? 4 : png[25] == 2 ? 3 : throw new NotSupportedException("Expected RGB or RGBA screenshot");
        using var compressed = new MemoryStream();
        for (int i = 8; i < png.Length;)
        {
            var length = U32(png, i);
            if (System.Text.Encoding.ASCII.GetString(png, i + 4, 4) == "IDAT") compressed.Write(png, i + 8, length);
            i += length + 12;
        }
        compressed.Position = 0;
        using var inflater = new ZLibStream(compressed, CompressionMode.Decompress);
        using var pixels = new MemoryStream();
        inflater.CopyTo(pixels);
        var raw = pixels.ToArray();
        var stride = width * bytesPerPixel;
        var previous = new byte[stride];
        var current = new byte[stride];
        for (int row = 0; row <= y; row++)
        {
            var filter = raw[row * (stride + 1)];
            for (int col = 0; col < stride; col++)
            {
                var left = col >= bytesPerPixel ? current[col - bytesPerPixel] : 0;
                var above = previous[col];
                var upperLeft = col >= bytesPerPixel ? previous[col - bytesPerPixel] : 0;
                var predictor = left + above - upperLeft;
                var da = Math.Abs(predictor - left);
                var db = Math.Abs(predictor - above);
                var dc = Math.Abs(predictor - upperLeft);
                var paeth = da <= db && da <= dc ? left : db <= dc ? above : upperLeft;
                var delta = filter switch { 0 => 0, 1 => left, 2 => above, 3 => (left + above) / 2, 4 => paeth, _ => throw new NotSupportedException("Unknown PNG filter") };
                current[col] = unchecked((byte)(raw[row * (stride + 1) + 1 + col] + delta));
            }
            (current, previous) = (previous, current);
        }
        return (previous[x * bytesPerPixel], previous[x * bytesPerPixel + 1], previous[x * bytesPerPixel + 2]);
    }

    private static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (var file in Directory.GetFiles(source)) File.Copy(file, Path.Combine(destination, Path.GetFileName(file)));
        foreach (var directory in Directory.GetDirectories(source)) CopyDirectory(directory, Path.Combine(destination, Path.GetFileName(directory)));
    }

    [Theory]
    [InlineData("\"layoutMode\":\"NONE\"", "\"layoutMode\":\"HORIZONTAL\"", "UNSUPPORTED_FEATURE")]
    [InlineData("\"clipsContent\":false", "\"clipsContent\":true", "UNSUPPORTED_FEATURE")]
    [InlineData("\"fontFamily\":\"Arial\"", "\"fontFamily\":\"Unknown\"", "MISSING_FONT")]
    [InlineData("\"parentId\":\"root\",\"type\":\"IMAGE\"", "\"parentId\":\"missing\",\"type\":\"IMAGE\"", "INVALID_SNAPSHOT")]
    public void UnsupportedOrBrokenInputsAreBlocked(string before, string after, string code)
    {
        using var doc = JsonDocument.Parse(Snapshot.Replace(before, after, StringComparison.Ordinal));
        var result = MinimalConverter.Convert(doc.RootElement, Assets);
        Assert.Empty(result.Screens);
        Assert.Contains(result.Diagnostics, d => d.Code == code && !string.IsNullOrWhiteSpace(d.NodeId) && !string.IsNullOrWhiteSpace(d.Message));
    }

    [Fact]
    public void ResponsiveChildRetainsAnchorsFillAndLimits()
    {
        var json = Snapshot.Replace("\"x\":10,\"y\":20,\"width\":200,\"height\":100", "\"x\":10,\"y\":20,\"width\":200,\"height\":100,\"horizontalSizing\":\"FILL\",\"horizontalAnchor\":\"STRETCH\",\"verticalAnchor\":\"MAX\",\"minWidth\":150,\"maxWidth\":900", StringComparison.Ordinal);
        using var doc = JsonDocument.Parse(json.Replace("\"minor\":0", "\"minor\":1", StringComparison.Ordinal));
        var screen = Assert.Single(MinimalConverter.Convert(doc.RootElement, Assets).Screens);
        var group = screen.Elements.Single(e => e.Name == "N1");
        Assert.Contains(group.Values, v => v.Name == "WidthUnits" && v.Value == "2");
        Assert.Contains(group.Values, v => v.Name == "Width" && v.Value == "-600");
        Assert.Contains(group.Values, v => v.Name == "MinWidth" && v.Value == "150");
        Assert.Contains(group.Values, v => v.Name == "MaxWidth" && v.Value == "900");
        Assert.Contains(group.Values, v => v.Name == "YUnits" && v.Value == "5");
        Assert.Contains(group.Values, v => v.Name == "Y" && v.Value == "-480");
    }

    [Fact]
    public void UnsupportedResponsiveCombinationsAndUnversionedFieldsBlock()
    {
        var json = Snapshot.Replace("\"x\":10,\"y\":20,\"width\":200,\"height\":100", "\"x\":10,\"y\":20,\"width\":200,\"height\":100,\"horizontalSizing\":\"FILL\",\"horizontalAnchor\":\"MAX\",\"minWidth\":300,\"maxWidth\":100", StringComparison.Ordinal);
        using var oldVersion = JsonDocument.Parse(json);
        Assert.Contains(MinimalConverter.Convert(oldVersion.RootElement, Assets).Diagnostics, d => d.Code == "INVALID_SNAPSHOT");
        using var doc = JsonDocument.Parse(json.Replace("\"minor\":0", "\"minor\":1", StringComparison.Ordinal));
        var result = MinimalConverter.Convert(doc.RootElement, Assets);
        Assert.Empty(result.Screens);
        Assert.Contains(result.Diagnostics, d => d.NodeId == "group" && d.Message.Contains("pair FILL with STRETCH", StringComparison.Ordinal));
        Assert.Contains(result.Diagnostics, d => d.NodeId == "group" && d.Message.Contains("exceeds", StringComparison.Ordinal));
    }

    [Fact]
    public void ResponsiveNativeGeometryChangesAtBothViewports()
    {
        var json = Snapshot.Replace("\"x\":10,\"y\":20,\"width\":200,\"height\":100,\"visible\":false", "\"x\":10,\"y\":20,\"width\":200,\"height\":100,\"visible\":true,\"color\":\"#ff0000\",\"horizontalSizing\":\"FILL\",\"horizontalAnchor\":\"STRETCH\",\"minWidth\":150,\"maxWidth\":500,\"verticalAnchor\":\"MAX\"", StringComparison.Ordinal);
        // A nested MAX anchor tracks its responsive parent; the other child tests CENTER,
        // and a second visual tests vertical FILL with min/max clamps.
        json = json.Replace("{\"id\":\"image\"", "{\"id\":\"right\",\"parentId\":\"group\",\"type\":\"FRAME\",\"name\":\"Right\",\"x\":170,\"y\":10,\"width\":20,\"height\":20,\"visible\":true,\"layoutMode\":\"NONE\",\"clipsContent\":false,\"color\":\"#00ff00\",\"horizontalAnchor\":\"MAX\"}," +
            "{\"id\":\"center\",\"parentId\":\"root\",\"type\":\"FRAME\",\"name\":\"Center\",\"x\":390,\"y\":300,\"width\":20,\"height\":20,\"visible\":true,\"layoutMode\":\"NONE\",\"clipsContent\":false,\"color\":\"#ffff00\",\"horizontalAnchor\":\"CENTER\"}," +
            "{\"id\":\"tall\",\"parentId\":\"root\",\"type\":\"FRAME\",\"name\":\"Tall\",\"x\":700,\"y\":0,\"width\":30,\"height\":100,\"visible\":true,\"layoutMode\":\"NONE\",\"clipsContent\":false,\"color\":\"#0000ff\",\"verticalSizing\":\"FILL\",\"verticalAnchor\":\"STRETCH\",\"minHeight\":240,\"maxHeight\":250}," +
            "{\"id\":\"minimum\",\"parentId\":\"root\",\"type\":\"FRAME\",\"name\":\"Minimum\",\"x\":100,\"y\":0,\"width\":100,\"height\":20,\"visible\":true,\"layoutMode\":\"NONE\",\"clipsContent\":false,\"color\":\"#ff00ff\",\"horizontalSizing\":\"FILL\",\"horizontalAnchor\":\"STRETCH\",\"minWidth\":400}," +
            "{\"id\":\"image\"", StringComparison.Ordinal);
        using var doc = JsonDocument.Parse(json.Replace("\"minor\":0", "\"minor\":1", StringComparison.Ordinal));
        var repository = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var sample = Path.Combine(repository, "samples/GumBridge.Sample/Content/GumProject");
        var stage = Path.Combine(Path.GetTempPath(), "gam217-" + Guid.NewGuid().ToString("N"));
        try
        {
            CopyDirectory(sample, stage);
            var asset = File.ReadAllBytes(Path.Combine(sample, "ExampleSpriteFrame.png"));
            var hash = Convert.ToHexStringLower(SHA256.HashData(asset));
            Directory.CreateDirectory(Path.Combine(stage, "Assets/Images"));
            File.WriteAllBytes(Path.Combine(stage, "Assets/Images", hash + ".png"), asset);
            var screen = Assert.Single(MinimalConverter.Convert(doc.RootElement, Assets).Screens);
            File.WriteAllText(Path.Combine(stage, "Screens/Golden.gusx"), GumModelSerializer.Serialize(screen));
            var project = XDocument.Load(Path.Combine(stage, "GumProject.gumx"));
            project.Root!.Add(new XElement("ScreenReference", new XAttribute("Name", "Golden")));
            project.Save(Path.Combine(stage, "GumProject.gumx"));
            var gumx = Path.Combine(stage, "GumProject.gumx");
            RunGumCli(repository, "check", gumx);
            foreach (var (width, height) in new[] { (1280, 720), (1024, 768) })
            {
                var png = Path.Combine(stage, $"responsive-{width}.png");
                RunGumCli(repository, "screenshot", gumx, "Golden", "--output", png, "--width", width.ToString(), "--height", height.ToString(), "--backend", "monogame");
                var bytes = File.ReadAllBytes(png);
                var groupRight = width == 1280 ? 510 : 434;
                var groupTop = height == 720 ? 140 : 188;
                var tallBottom = height == 720 ? 240 : 250;
                var minRight = width == 1280 ? 680 : 500;
                AssertRenderedBounds(bytes, 10, groupTop, groupRight, groupTop + 100, (255, 0, 0), $"group {width}x{height}");
                AssertRenderedBounds(bytes, groupRight - 30, groupTop + 10, groupRight - 10, groupTop + 30, (0, 255, 0), $"nested MAX {width}x{height}");
                AssertRenderedBounds(bytes, width / 2 - 10, 300, width / 2 + 10, 320, (255, 255, 0), $"CENTER {width}x{height}");
                AssertRenderedBounds(bytes, 700, 0, 730, tallBottom, (0, 0, 255), $"height min/max {width}x{height}");
                AssertRenderedBounds(bytes, 100, 0, minRight, 20, (255, 0, 255), $"width min/max {width}x{height}");
            }
        }
        finally { if (Directory.Exists(stage)) Directory.Delete(stage, recursive: true); }
    }

    // Gum's native Rectangle paints its solid interior two pixels inside its layout bounds.
    // Probe each painted edge within one pixel at both viewport sizes, not just a center pixel.
    private static void AssertRenderedBounds(byte[] png, int left, int top, int right, int bottom,
        (byte R, byte G, byte B) color, string name)
    {
        left += 2;
        top += 2;
        right -= 2;
        bottom -= 2;
        static bool Matches((byte R, byte G, byte B) actual, (byte R, byte G, byte B) expected) =>
            Math.Abs(actual.R - expected.R) <= 1 && Math.Abs(actual.G - expected.G) <= 1 && Math.Abs(actual.B - expected.B) <= 1;
        void Probe(int x, int y, bool expected) =>
            Assert.True(Matches(ReadPngPixel(png, x, y), color) == expected, $"{name}: pixel ({x},{y}) is {ReadPngPixel(png, x, y)}; should {(expected ? "match" : "not match")} {color}");
        var midX = (left + right) / 2;
        var midY = (top + bottom) / 2;
        if (left >= 2) Probe(left - 2, midY, false);
        Probe(left + 1, midY, true);
        Probe(right - 2, midY, true);
        Probe(right + 1, midY, false);
        if (top >= 2) Probe(midX, top - 2, false);
        Probe(midX, top + 1, true);
        Probe(midX, bottom - 2, true);
        Probe(midX, bottom + 1, false);
    }

    [Fact]
    public void ResponsiveImageAndInvalidParentAndFloatLimitsReturnDiagnostics()
    {
        foreach (var field in new[] { "\"horizontalSizing\":\"FILL\",\"horizontalAnchor\":\"STRETCH\"", "\"minWidth\":50" })
        {
            using var image = JsonDocument.Parse(Snapshot.Replace("\"scaleMode\":\"FILL\"", $"{field},\"scaleMode\":\"FILL\"", StringComparison.Ordinal).Replace("\"minor\":0", "\"minor\":1", StringComparison.Ordinal));
            var result = MinimalConverter.Convert(image.RootElement, Assets);
            Assert.Empty(result.Screens);
            Assert.Contains(result.Diagnostics, d => d.NodeId == "image" && d.Message.Contains("image", StringComparison.OrdinalIgnoreCase));
        }
        using var parent = JsonDocument.Parse(Snapshot.Replace("\"parentId\":\"root\",\"type\":\"IMAGE\"", "\"parentId\":\"label\",\"type\":\"IMAGE\",\"horizontalAnchor\":\"MAX\"", StringComparison.Ordinal).Replace("\"minor\":0", "\"minor\":1", StringComparison.Ordinal));
        Assert.Contains(MinimalConverter.Convert(parent.RootElement, Assets).Diagnostics, d => d.Message.Contains("non-frame parent", StringComparison.Ordinal));
        using var limit = JsonDocument.Parse(Snapshot.Replace("\"visible\":false,\"layoutMode\":\"NONE\"", "\"visible\":false,\"maxWidth\":1e100,\"layoutMode\":\"NONE\"", StringComparison.Ordinal).Replace("\"minor\":0", "\"minor\":1", StringComparison.Ordinal));
        Assert.Contains(MinimalConverter.Convert(limit.RootElement, Assets).Diagnostics, d => d.Message.Contains("float range", StringComparison.Ordinal));
    }

    [Fact]
    public void MissingImageDimensionsBlockBothFitAndFill()
    {
        using var doc = JsonDocument.Parse(Snapshot);
        Assert.Contains(MinimalConverter.Convert(doc.RootElement).Diagnostics, d => d.Code == "UNSUPPORTED_FEATURE" && d.NodeId == "image");
    }

    [Fact]
    public void InvalidWireContractIsBlocked()
    {
        using var doc = JsonDocument.Parse(Snapshot.Replace("\"width\":800", "\"width\":-1", StringComparison.Ordinal));
        Assert.Contains(MinimalConverter.Convert(doc.RootElement, Assets).Diagnostics, d => d.Code == "INVALID_SNAPSHOT");
    }
}
