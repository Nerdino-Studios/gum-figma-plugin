using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace GumBridge.Host;

// Bounded workspace-local Angelcode text descriptor and PNG atlas validation before invoking Gum.
public static class FontAssetValidator
{
    public static void Validate(string descriptorPath, string? characters = null, int? expectedSize = null)
    {
        if (new FileInfo(descriptorPath).Length is < 1 or > 1048576) throw Missing("descriptor size");
        // Normalize only for parsing. The caller hashes the original descriptor bytes unchanged.
        var text = File.ReadAllText(descriptorPath).Replace("\r\n", "\n").Replace('\r', '\n');
        var info = Regex.Match(text, "(?m)^info face=\\\"[^\\\"\\r\\n]+\\\"[^\\r\\n]*$");
        var header = Regex.Match(text, @"(?m)^common\b[^\r\n]*$");
        var count = Regex.Match(text, @"(?m)^chars count=(\d+)\s*$");
        static int Field(string line, string key) =>
            int.TryParse(Regex.Match(line, @"(?:^|\s)" + Regex.Escape(key) + @"=(-?\d+)(?:\s|$)").Groups[1].Value, out var value) ? value : int.MinValue;
        var fontSize = Field(info.Value, "size");
        var lineHeight = Field(header.Value, "lineHeight");
        var baseline = Field(header.Value, "base");
        var atlasWidth = Field(header.Value, "scaleW");
        var atlasHeight = Field(header.Value, "scaleH");
        var pageCount = Field(header.Value, "pages");
        var pages = Regex.Matches(text, "(?m)^page id=(\\d+) file=\\\"([A-Za-z0-9_-]+\\.png)\\\"\\s*$");
        var glyphs = Regex.Matches(text, @"(?m)^char id=(\d+)\b[^\r\n]*\bpage=(\d+)\b[^\r\n]*$");
        if (!info.Success || !header.Success || fontSize is < 1 or > 256 || expectedSize is not null && fontSize != expectedSize ||
            lineHeight is < 1 or > 4096 || baseline < 0 || baseline > lineHeight ||
            atlasWidth is < 1 or > 4096 || atlasHeight is < 1 or > 4096 ||
            pageCount is < 1 or > 16 || pages.Count != pageCount || Regex.Matches(text, @"(?m)^page ").Count != pageCount ||
            !int.TryParse(count.Groups[1].Value, out var glyphCount) || glyphCount is < 1 or > 65536 ||
            glyphs.Count != glyphCount || Regex.Matches(text, @"(?m)^char ").Count != glyphCount)
            throw Missing("descriptor pages/glyphs");
        var ids = new HashSet<int>();
        foreach (Match glyph in glyphs)
        {
            if (!int.TryParse(glyph.Groups[1].Value, out var id) || !ids.Add(id) ||
                !int.TryParse(glyph.Groups[2].Value, out var glyphPage) || glyphPage < 0 || glyphPage >= pageCount)
                throw Missing("duplicate or invalid glyph/page");
            var x = Field(glyph.Value, "x"); var y = Field(glyph.Value, "y");
            var width = Field(glyph.Value, "width"); var height = Field(glyph.Value, "height");
            if (x < 0 || y < 0 || width < 0 || height < 0 || (long)x + width > atlasWidth || (long)y + height > atlasHeight ||
                Field(glyph.Value, "xoffset") == int.MinValue || Field(glyph.Value, "yoffset") == int.MinValue ||
                Field(glyph.Value, "xadvance") == int.MinValue || Field(glyph.Value, "chnl") is < 0 or > 15)
                throw Missing("invalid glyph metrics or atlas rectangle");
        }
        if (characters is not null)
            foreach (var rune in characters.EnumerateRunes())
                if (!System.Text.Rune.IsControl(rune) && !ids.Contains(rune.Value)) throw Missing("font lacks a required glyph");
        var seenPages = new HashSet<int>();
        foreach (Match page in pages)
        {
            if (!int.TryParse(page.Groups[1].Value, out var id) || id < 0 || id >= pageCount || !seenPages.Add(id))
                throw Missing("duplicate or invalid page ID");
            var file = Path.Combine(Path.GetDirectoryName(descriptorPath)!, page.Groups[2].Value);
            if (!File.Exists(file) || (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw Missing("missing atlas");
            if (ValidatePng(file) != ((uint)atlasWidth, (uint)atlasHeight)) throw Missing("atlas dimensions differ from descriptor");
        }
    }

    private static (uint Width, uint Height) ValidatePng(string path)
    {
        var length = new FileInfo(path).Length;
        if (length is < 68 or > 8388608) throw Missing("atlas byte limit");
        var png = File.ReadAllBytes(path);
        if (!png.AsSpan(0, 8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 })) throw Missing("atlas signature");
        var offset = 8;
        uint width = 0, height = 0;
        int channels = 0;
        var ended = false;
        using var compressed = new MemoryStream();
        while (offset < png.Length)
        {
            if (png.Length - offset < 12) throw Missing("truncated PNG chunk");
            var size = BinaryPrimitives.ReadUInt32BigEndian(png.AsSpan(offset, 4));
            if (size > png.Length - offset - 12) throw Missing("PNG chunk size");
            var name = Encoding.ASCII.GetString(png, offset + 4, 4);
            var payload = png.AsSpan(offset + 8, (int)size);
            var crc = BinaryPrimitives.ReadUInt32BigEndian(png.AsSpan(offset + 8 + (int)size, 4));
            uint actual = 0xffffffff;
            foreach (var b in png.AsSpan(offset + 4, (int)size + 4))
            {
                actual ^= b;
                for (var bit = 0; bit < 8; bit++) actual = (actual >> 1) ^ ((actual & 1) != 0 ? 0xedb88320u : 0);
            }
            if (~actual != crc) throw Missing("PNG CRC mismatch");
            if (offset == 8 && name != "IHDR") throw Missing("PNG missing IHDR");
            if (name == "IHDR")
            {
                if (offset != 8 || size != 13) throw Missing("invalid PNG IHDR");
                width = BinaryPrimitives.ReadUInt32BigEndian(payload[..4]);
                height = BinaryPrimitives.ReadUInt32BigEndian(payload.Slice(4, 4));
                channels = payload[9] switch { 2 => 3, 6 => 4, _ => 0 };
                if (width is < 1 or > 4096 || height is < 1 or > 4096 || (long)width * height > 4194304 ||
                    payload[8] != 8 || channels == 0 || payload[10] != 0 || payload[11] != 0 || payload[12] != 0)
                    throw Missing("unsupported atlas pixels");
            }
            if (name == "IDAT") compressed.Write(payload);
            if (name == "IEND")
            {
                if (size != 0 || offset + 12 != png.Length) throw Missing("invalid PNG end");
                ended = true;
            }
            offset += (int)size + 12;
        }
        if (!ended || compressed.Length == 0) throw Missing("missing PNG pixels");
        compressed.Position = 0;
        using var zlib = new ZLibStream(compressed, CompressionMode.Decompress);
        try
        {
            var row = new byte[checked(1 + (int)width * channels)];
            for (var y = 0; y < height; y++)
            {
                zlib.ReadExactly(row);
                if (row[0] > 4) throw Missing("invalid PNG filter");
            }
            if (zlib.ReadByte() != -1) throw Missing("extra PNG pixels");
        }
        catch (EndOfStreamException) { throw Missing("truncated PNG pixels"); }
        catch (InvalidDataException) { throw Missing("invalid PNG compression"); }
        return (width, height);
    }
    private static InvalidOperationException Missing(string reason) => new("MISSING_FONT: " + reason);
}
