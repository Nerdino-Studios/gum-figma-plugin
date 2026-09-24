using System;
using System.IO;
using System.Linq;
using System.Diagnostics;
using System.Text.Json;
using System.Xml.Linq;
using GumBridge.Conversion;
using GumBridge.Infrastructure.Gum;
using Xunit;

namespace GumBridge.Contracts.Tests;

public sealed class StackLayoutTests
{
    private const string Nodes = """
      {"schemaVersion":{"major":1,"minor":2},"snapshotId":"stack","documentNamespace":"test",
       "selectedRootIds":["root"],"rootAliases":[{"rootId":"root","alias":"Stack"}],"nodes":[
       {"id":"root","parentId":null,"type":"FRAME","name":"Root","x":0,"y":0,"width":800,"height":600,"visible":true,"layoutMode":"NONE","clipsContent":false},
       {"id":"outer","parentId":"root","type":"FRAME","name":"Outer","x":10,"y":20,"width":240,"height":120,"visible":true,"layoutMode":"HORIZONTAL","clipsContent":false,"itemSpacing":7,"paddingLeft":11,"paddingRight":19,"paddingTop":13,"paddingBottom":17,"counterAxisAlignItems":"CENTER","color":"#ff0000"},
       {"id":"first","parentId":"outer","type":"FRAME","name":"First","x":11,"y":43,"width":40,"height":30,"visible":true,"layoutMode":"NONE","clipsContent":false,"color":"#00ff00"},
       {"id":"inner","parentId":"outer","type":"FRAME","name":"Inner","x":58,"y":33,"width":60,"height":50,"visible":true,"layoutMode":"VERTICAL","clipsContent":false,"itemSpacing":5,"paddingLeft":3,"paddingRight":9,"paddingTop":4,"paddingBottom":8,"horizontalSizing":"HUG","verticalSizing":"HUG","color":"#0000ff"},
       {"id":"leaf","parentId":"inner","type":"FRAME","name":"Leaf","x":3,"y":4,"width":48,"height":38,"visible":true,"layoutMode":"NONE","clipsContent":false,"color":"#ffff00"}]}
      """;

    [Fact]
    public void NestedAsymmetricStackLowersToNativeContainersAndInsets()
    {
        using var doc = JsonDocument.Parse(Nodes);
        var result = MinimalConverter.Convert(doc.RootElement);
        Assert.Empty(result.Diagnostics);
        var elements = Assert.Single(result.Screens).Elements;
        var outer = elements.Single(e => e.Name == "N1");
        var content = elements.Single(e => e.Name == "N1_Content");
        Assert.Contains(content.Values, v => v.Name == "ChildrenLayout" && v.Value == "2");
        Assert.Contains(content.Values, v => v.Name == "StackSpacing" && v.Value == "7");
        Assert.Equal("N1", content.Parent);
        Assert.Contains(content.Values, v => v.Name == "X" && v.Value == "11");
        Assert.Contains(content.Values, v => v.Name == "Y" && v.Value == "13");
        Assert.Contains(content.Values, v => v.Name == "Width" && v.Value == "-30");
        Assert.Contains(content.Values, v => v.Name == "Height" && v.Value == "-30");
        Assert.Equal("N1_Content", elements.Single(e => e.Name == "N2").Parent);
        var inner = elements.Single(e => e.Name == "N3");
        Assert.Contains(inner.Values, v => v.Name == "WidthUnits" && v.Value == "4");
        Assert.Contains(inner.Values, v => v.Name == "HeightUnits" && v.Value == "4");
        Assert.Contains(inner.Values, v => v.Name == "Width" && v.Value == "9");
        Assert.Contains(inner.Values, v => v.Name == "Height" && v.Value == "8");
        Assert.Equal("N3_Content", elements.Single(e => e.Name == "N4").Parent);
        Assert.Contains(elements.Single(e => e.Name == "N2").Values, v => v.Name == "YUnits" && v.Value == "7");
        Assert.Equal("N1", elements.Single(e => e.Name == "N1_Background").Parent);
        Assert.Contains(elements.Single(e => e.Name == "N1_Background").Values, v => v.Name == "IgnoredByParentSize" && v.Value == "true");
    }

    [Fact]
    public void NativeStackLoadsAndRendersAtBothReferenceSizes()
    {
        var repository = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        var sample = Path.Combine(repository, "samples/GumBridge.Sample/Content/GumProject");
        var stage = Path.Combine(Path.GetTempPath(), "gam219-" + Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(Path.Combine(stage, "Screens"));
            foreach (var filename in new[] { "GumProject.gumx" }) File.Copy(Path.Combine(sample, filename), Path.Combine(stage, filename));
            foreach (var directory in new[] { "Screens", "Standards", "Fonts" })
                if (Directory.Exists(Path.Combine(sample, directory))) Copy(Path.Combine(sample, directory), Path.Combine(stage, directory));
            using var doc = JsonDocument.Parse(Nodes);
            File.WriteAllText(Path.Combine(stage, "Screens/Stack.gusx"), GumModelSerializer.Serialize(Assert.Single(MinimalConverter.Convert(doc.RootElement).Screens)));
            var responsive = Nodes.Replace("\"width\":240,\"height\":120,\"visible\":true", "\"width\":240,\"height\":120,\"verticalSizing\":\"FILL\",\"verticalAnchor\":\"STRETCH\",\"visible\":true", StringComparison.Ordinal)
                .Replace("\"width\":40,\"height\":30,\"visible\":true", "\"width\":40,\"height\":90,\"verticalSizing\":\"FILL\",\"verticalAnchor\":\"STRETCH\",\"visible\":true", StringComparison.Ordinal)
                .Replace("\"alias\":\"Stack\"", "\"alias\":\"Responsive\"", StringComparison.Ordinal);
            using var resizedDoc = JsonDocument.Parse(responsive);
            File.WriteAllText(Path.Combine(stage, "Screens/Responsive.gusx"), GumModelSerializer.Serialize(Assert.Single(MinimalConverter.Convert(resizedDoc.RootElement).Screens)));
            var project = XDocument.Load(Path.Combine(stage, "GumProject.gumx"));
            project.Root!.Add(new XElement("ScreenReference", new XAttribute("Name", "Stack")));
            project.Root!.Add(new XElement("ScreenReference", new XAttribute("Name", "Responsive")));
            project.Save(Path.Combine(stage, "GumProject.gumx"));
            var gumx = Path.Combine(stage, "GumProject.gumx");
            Run(repository, "check", gumx);
            foreach (var (width, height) in new[] { (1280, 720), (1024, 768) })
            {
                var output = Path.Combine(stage, $"stack-{width}.png");
                Run(repository, "screenshot", gumx, "Stack", "--output", output, "--width", width.ToString(), "--height", height.ToString(), "--backend", "monogame");
                Assert.True(File.Exists(output) && new FileInfo(output).Length > 100);
                var pixels = File.ReadAllBytes(output);
                Assert.Equal((255, 0, 0), MinimalConversionTests.ReadPngPixel(pixels, 15, 25));
                Assert.Equal((0, 255, 0), MinimalConversionTests.ReadPngPixel(pixels, 25, 70));
                Assert.Equal((0, 0, 255), MinimalConversionTests.ReadPngPixel(pixels, 125, 56));
                Assert.Equal((255, 0, 0), MinimalConversionTests.ReadPngPixel(pixels, 64, 70)); // 7px stack gap
                Assert.Equal((255, 0, 0), MinimalConversionTests.ReadPngPixel(pixels, 130, 56)); // hug ends at x=128
                var yellow = MinimalConversionTests.ReadPngPixel(pixels, 90, 80);
                Assert.True(yellow.R == 255 && yellow.G >= 254 && yellow.B == 0);
                var fillOutput = Path.Combine(stage, $"fill-{width}.png");
                Run(repository, "screenshot", gumx, "Responsive", "--output", fillOutput, "--width", width.ToString(), "--height", height.ToString(), "--backend", "monogame");
                var fill = File.ReadAllBytes(fillOutput);
                Assert.Equal((0, 255, 0), MinimalConversionTests.ReadPngPixel(fill, 25, height - 490));
                Assert.Equal((255, 0, 0), MinimalConversionTests.ReadPngPixel(fill, 25, height - 466));
                Assert.Equal((255, 0, 0), MinimalConversionTests.ReadPngPixel(fill, 64, 70));
            }
        }
        finally { if (Directory.Exists(stage)) Directory.Delete(stage, true); }
    }

    private static void Copy(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (var file in Directory.GetFiles(source)) File.Copy(file, Path.Combine(destination, Path.GetFileName(file)));
        foreach (var directory in Directory.GetDirectories(source)) Copy(directory, Path.Combine(destination, Path.GetFileName(directory)));
    }

    private static void Run(string repository, params string[] args)
    {
        var start = new ProcessStartInfo("dotnet") { WorkingDirectory = repository, RedirectStandardOutput = true, RedirectStandardError = true };
        start.Environment["DOTNET_ROLL_FORWARD"] = "Major";
        foreach (var arg in new[] { "tool", "run", "gumcli", "--" }.Concat(args)) start.ArgumentList.Add(arg);
        using var process = Process.Start(start)!;
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(60000) && process.ExitCode == 0, stdout + stderr);
    }

    [Fact]
    public void ChildAlignmentOverridesStackCrossAxis()
    {
        using var doc = JsonDocument.Parse(Nodes.Replace("\"verticalSizing\":\"HUG\",\"color\":\"#0000ff\"",
            "\"verticalSizing\":\"HUG\",\"layoutAlign\":\"MAX\",\"color\":\"#0000ff\"", StringComparison.Ordinal));
        var result = MinimalConverter.Convert(doc.RootElement);
        Assert.Empty(result.Diagnostics);
        var inner = Assert.Single(result.Screens).Elements.Single(e => e.Name == "N3");
        Assert.Contains(inner.Values, v => v.Name == "YUnits" && v.Value == "5");
        Assert.Contains(inner.Values, v => v.Name == "Y" && v.Value == "0");
    }

    [Fact]
    public void PaddedCrossAxisFillUsesInnerDimensionsNotOuter()
    {
        var json = Nodes.Replace("\"width\":40,\"height\":30,\"visible\":true", "\"width\":40,\"height\":90,\"verticalSizing\":\"FILL\",\"verticalAnchor\":\"STRETCH\",\"visible\":true", StringComparison.Ordinal);
        using var doc = JsonDocument.Parse(json);
        var result = MinimalConverter.Convert(doc.RootElement);
        Assert.Empty(result.Diagnostics);
        var child = Assert.Single(result.Screens).Elements.Single(e => e.Name == "N2");
        Assert.Contains(child.Values, v => v.Name == "Height" && v.Value == "0");
        Assert.Contains(child.Values, v => v.Name == "HeightUnits" && v.Value == "2");
    }

    [Theory]
    [InlineData("MAX")]
    [InlineData("CENTER")]
    public void HugCrossAxisRejectsChildAlignmentCycle(string align)
    {
        // Align the leaf inside the HUG-width vertical stack (not the frame in its fixed-width parent).
        var json = Nodes.Replace("\"width\":48,\"height\":38,\"visible\":true",
            "\"width\":48,\"height\":38,\"layoutAlign\":\"" + align + "\",\"visible\":true", StringComparison.Ordinal);
        using var doc = JsonDocument.Parse(json);
        var result = MinimalConverter.Convert(doc.RootElement);
        Assert.Empty(result.Screens);
        Assert.Contains(result.Diagnostics, d => d.NodeId == "inner" && d.Message.Contains("cycle", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void HugDependingOnFillChildIsRejected()
    {
        using var doc = JsonDocument.Parse(Nodes.Replace("\"width\":48,\"height\":38,\"visible\":true", "\"width\":48,\"height\":38,\"horizontalSizing\":\"FILL\",\"horizontalAnchor\":\"STRETCH\",\"visible\":true", StringComparison.Ordinal));
        var result = MinimalConverter.Convert(doc.RootElement);
        Assert.Empty(result.Screens);
        Assert.Contains(result.Diagnostics, d => d.NodeId == "inner" && d.Message.Contains("cycle", StringComparison.OrdinalIgnoreCase));
    }
}
