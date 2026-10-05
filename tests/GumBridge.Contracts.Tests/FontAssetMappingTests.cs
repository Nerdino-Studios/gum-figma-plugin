using System;
using System.Collections.Generic;
using System.Linq;
using System.IO;
using System.Security.Cryptography;
using GumBridge.Host;
using System.Text.Json;
using GumBridge.Conversion;
using Xunit;

namespace GumBridge.Contracts.Tests;

public sealed class FontAssetMappingTests
{
    private const string Snapshot = """
        {"schemaVersion":{"major":1,"minor":0},"snapshotId":"fixture","documentNamespace":"ns","selectedRootIds":["root"],
        "rootAliases":[{"rootId":"root","alias":"Main"}],"nodes":[
        {"id":"root","parentId":null,"type":"FRAME","name":"Root","x":0,"y":0,"width":200,"height":100,"visible":true,"layoutMode":"NONE","clipsContent":false},
        {"id":"label","parentId":"root","type":"TEXT","name":"Label","x":0,"y":0,"width":100,"height":30,"visible":true,
        "fontFamily":"Licensed Family","fontStyle":"Regular","fontSize":18,"characters":"Hello"}]}
        """;
    [Fact]
    public void MissingFontDescriptorAndAtlasBlockBeforePreview()
    {
        var root = Path.Combine(Path.GetTempPath(), "gam216-font-" + Guid.NewGuid().ToString("N"));
        var fontDir = Path.Combine(root, "Gum", "Assets", "Fonts");
        Directory.CreateDirectory(fontDir);
        try
        {
            var font = Path.Combine(fontDir, "licensed.fnt");
            var descriptor = "info face=\"Licensed\" size=18\ncommon lineHeight=18 base=14 scaleW=1 scaleH=1 pages=1 packed=0\npage id=0 file=\"licensed.png\"\nchars count=1\nchar id=72 x=0 y=0 width=1 height=1 xoffset=0 yoffset=0 xadvance=1 page=0 chnl=15\n";
            File.WriteAllText(font, descriptor);
            var digest = "sha256:" + Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(font)));
            File.WriteAllText(Path.Combine(root, "font-mappings.json"),
                System.Text.Json.JsonSerializer.Serialize(new[] { new { family = "Licensed Family", style = "Regular", size = 18, file = "Assets/Fonts/licensed.fnt", sha256 = digest } }));
            var entry = new WorkspaceEntry("id", "Sample", "sample", root, "Sample.csproj", "Gum/project.gumx");
            Assert.Contains("MISSING_FONT", Assert.Throws<InvalidOperationException>(() => PreviewOperation.ReadFontMappings(entry)).Message);
            var pngPath = Path.Combine(fontDir, "licensed.png");
            File.WriteAllBytes(pngPath, new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 });
            Assert.Contains("MISSING_FONT", Assert.Throws<InvalidOperationException>(() => PreviewOperation.ReadFontMappings(entry)).Message);
            File.WriteAllBytes(pngPath, Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="));
            Assert.Single(PreviewOperation.ReadFontMappings(entry));
            File.WriteAllText(font, descriptor.Replace("\n", "\r\n"));
            FontAssetValidator.Validate(font, "H", 18);
            var crlfDigest = "sha256:" + Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(font)));
            File.WriteAllText(Path.Combine(root, "font-mappings.json"),
                JsonSerializer.Serialize(new[] { new { family = "Licensed Family", style = "Regular", size = 18, file = "Assets/Fonts/licensed.fnt", sha256 = crlfDigest } }));
            Assert.Single(PreviewOperation.ReadFontMappings(entry));
            File.WriteAllText(font, descriptor);
            File.WriteAllText(Path.Combine(root, "font-mappings.json"),
                JsonSerializer.Serialize(new[] { new { family = "Licensed Family", style = "Regular", size = 18, file = "Assets/Fonts/licensed.fnt", sha256 = digest } }));
            Assert.Contains("MISSING_FONT", Assert.Throws<InvalidOperationException>(() => FontAssetValidator.Validate(font, "Hello")).Message);
            File.WriteAllText(font, "common pages=1\npage id=0 file=\"licensed.png\"\nchars count=1\nchar id=72 page=0\n");
            Assert.Contains("MISSING_FONT", Assert.Throws<InvalidOperationException>(() => FontAssetValidator.Validate(font, "H")).Message);
            File.WriteAllText(font, descriptor.Replace("x=0 y=0 width=1", "x=2 y=0 width=1"));
            Assert.Contains("MISSING_FONT", Assert.Throws<InvalidOperationException>(() => FontAssetValidator.Validate(font, "H")).Message);
            File.WriteAllText(font, descriptor);
            File.WriteAllBytes(pngPath, new byte[8388609]);
            Assert.Contains("MISSING_FONT", Assert.Throws<InvalidOperationException>(() => PreviewOperation.ReadFontMappings(entry)).Message);
            File.WriteAllBytes(pngPath, Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="));
            File.AppendAllText(font, "change");
            Assert.Contains("MISSING_FONT", Assert.Throws<InvalidOperationException>(() => PreviewOperation.ReadFontMappings(entry)).Message);
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public void UnmappedFontBlocksAndMappedFontUsesExplicitNativeAsset()
    {
        using var json = JsonDocument.Parse(Snapshot);
        Assert.Contains(MinimalConverter.Convert(json.RootElement).Diagnostics, d => d.Code == "MISSING_FONT");
        var fonts = new Dictionary<FontKey, FontAsset> { [new("Licensed Family", "Regular", 18)] = new("Assets/Fonts/licensed.fnt", "sha256:" + new string('a', 64)) };
        var converted = MinimalConverter.Convert(json.RootElement, null, fonts);
        Assert.Empty(converted.Diagnostics);
        var text = converted.Screens.Single().Elements.Single(e => e.Type == "Text");
        Assert.Contains(text.Values, v => v.Name == "UseCustomFont" && v.Value == "true");
        Assert.Contains(text.Values, v => v.Name == "CustomFontFile" && v.Value == "Assets/Fonts/licensed.fnt");
    }
}
