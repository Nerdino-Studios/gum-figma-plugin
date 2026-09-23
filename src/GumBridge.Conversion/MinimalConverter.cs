using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using GumBridge.Contracts;

namespace GumBridge.Conversion;

public sealed record ConversionDiagnostic(string Code, string NodeId, string Message);
public sealed record GumElement(string Name, string Type, string? Parent, bool Visible, IReadOnlyList<GumValue> Values);
public sealed record GumValue(string Name, string Type, string Value);
public sealed record GumScreen(string Name, IReadOnlyList<GumElement> Elements);
public sealed record ConversionResult(IReadOnlyList<GumScreen> Screens, IReadOnlyList<ConversionDiagnostic> Diagnostics);

/// <summary>Pure lowering of the v1 fixed-size, unrotated minimal subset. All other semantic layouts block output.</summary>
public static class MinimalConverter
{
    public static ConversionResult Convert(JsonElement snapshot, IReadOnlyDictionary<string, (double Width, double Height)>? imageDimensions = null)
    {
        var errors = new List<ConversionDiagnostic>();
        if (!WireContracts.Validate("snapshot", snapshot))
            return new([], [new("INVALID_SNAPSHOT", "snapshot", "Expected valid v1 snapshot; correct malformed or unknown semantic fields")]);
        if (snapshot.TryGetProperty("extractionDiagnostics", out var existing))
            foreach (var diagnostic in existing.EnumerateArray())
                errors.Add(new("UNSUPPORTED_FEATURE", "snapshot", diagnostic.GetProperty("message").GetString()!));
        var nodes = snapshot.GetProperty("nodes").EnumerateArray().ToArray();
        var byId = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var node in nodes)
        {
            var id = node.GetProperty("id").GetString()!;
            if (!byId.TryAdd(id, node)) errors.Add(new("INVALID_SNAPSHOT", id, "Duplicate node ID"));
        }
        var roots = snapshot.GetProperty("selectedRootIds").EnumerateArray().Select(x => x.GetString()!).ToArray();
        var aliases = snapshot.GetProperty("rootAliases").EnumerateArray().ToDictionary(x => x.GetProperty("rootId").GetString()!, x => x.GetProperty("alias").GetString()!, StringComparer.Ordinal);
        if (roots.Length != 1 || !byId.TryGetValue(roots[0], out var root) || root.GetProperty("type").GetString() != "FRAME" || root.GetProperty("parentId").ValueKind != JsonValueKind.Null || !aliases.ContainsKey(roots[0]))
            errors.Add(new("INVALID_SNAPSHOT", "snapshot", "Select one top-level FRAME with a root alias"));
        if (aliases.Values.Any(x => !System.Text.RegularExpressions.Regex.IsMatch(x, @"^[A-Za-z][A-Za-z0-9_]*$", System.Text.RegularExpressions.RegexOptions.CultureInvariant)))
            errors.Add(new("INVALID_SNAPSHOT", "snapshot", "Root alias must be a safe Gum screen identifier"));
        if (nodes.Length == 0 || nodes[0].GetProperty("id").GetString() != roots.FirstOrDefault())
            errors.Add(new("INVALID_SNAPSHOT", "snapshot", "Selected root must appear first in paint order"));
        var names = new Dictionary<string, string>(StringComparer.Ordinal);
        for (int i = 0; i < nodes.Length; i++) names[nodes[i].GetProperty("id").GetString()!] = "N" + i.ToString(CultureInfo.InvariantCulture);
        var elements = new List<GumElement>();
        foreach (var node in nodes)
        {
            string id = node.GetProperty("id").GetString()!;
            string type = node.GetProperty("type").GetString()!;
            string? parentId = node.GetProperty("parentId").ValueKind == JsonValueKind.Null ? null : node.GetProperty("parentId").GetString();
            if (parentId is not null && (!names.TryGetValue(parentId, out var parentNameIndex) || int.Parse(parentNameIndex[1..], CultureInfo.InvariantCulture) >= int.Parse(names[id][1..], CultureInfo.InvariantCulture)))
                errors.Add(new("INVALID_SNAPSHOT", id, "Parent must precede children in paint order"));
            if (id != roots.FirstOrDefault() && (parentId is null || !byId.TryGetValue(parentId, out var parent) || parent.GetProperty("type").GetString() != "FRAME"))
                errors.Add(new("INVALID_SNAPSHOT", id, "Missing or non-frame parent"));
            var seen = new HashSet<string>(StringComparer.Ordinal) { id };
            var cursor = parentId;
            while (cursor is not null && byId.TryGetValue(cursor, out var ancestor))
            {
                if (!seen.Add(cursor)) { errors.Add(new("INVALID_SNAPSHOT", id, "Parent cycle")); break; }
                cursor = ancestor.GetProperty("parentId").ValueKind == JsonValueKind.Null ? null : ancestor.GetProperty("parentId").GetString();
            }
            if (id != roots.FirstOrDefault() && !seen.Contains(roots.FirstOrDefault() ?? "")) errors.Add(new("INVALID_SNAPSHOT", id, "Node is outside selected root"));
            if (new[] { "x", "y", "width", "height" }.Any(key => Math.Abs(node.GetProperty(key).GetDouble()) > float.MaxValue))
                errors.Add(new("INVALID_SNAPSHOT", id, "Geometry exceeds native Gum float range"));
            if (type == "FRAME" && (node.GetProperty("layoutMode").GetString() != "NONE" || node.GetProperty("clipsContent").GetBoolean()))
                errors.Add(new("UNSUPPORTED_FEATURE", id, "Auto layout and clipping require a later conversion rule"));
            if (type == "TEXT" && node.TryGetProperty("color", out _))
                errors.Add(new("UNSUPPORTED_FEATURE", id, "Text color mapping requires a verified native rule"));
            if (type == "TEXT" && (node.GetProperty("fontFamily").GetString() != "Arial" || node.GetProperty("fontStyle").GetString() != "Regular" || node.GetProperty("fontSize").GetDouble() != 24))
                errors.Add(new("MISSING_FONT", id, "Minimal sample supports pinned Arial Regular 24 only; configure a verified font mapping"));
            if (type == "IMAGE")
            {
                var hash = node.GetProperty("imageHash").GetString()!;
                var width = node.GetProperty("width").GetDouble();
                var height = node.GetProperty("height").GetDouble();
                if (imageDimensions is null || !imageDimensions.TryGetValue(hash, out var size) ||
                    !double.IsFinite(size.Width) || !double.IsFinite(size.Height) || size.Width <= 0 || size.Height <= 0 ||
                    width <= 0 || height <= 0 || Math.Abs(width / height - size.Width / size.Height) > 0.000001)
                    errors.Add(new("UNSUPPORTED_FEATURE", id, "FIT/FILL requires verified source image dimensions and matching aspect ratio; cropping and letterboxing are not yet supported"));
            }
            if (id == roots.FirstOrDefault())
            {
                if (!node.GetProperty("visible").GetBoolean()) errors.Add(new("UNSUPPORTED_FEATURE", id, "Invisible export root cannot be represented as a visible screen"));
                if (node.TryGetProperty("color", out var rootColor)) elements.Add(Visual(names[id] + "_Background", "Rectangle", null, true, node, rootColor.GetString()!, screenOrigin: true));
                continue;
            }
            var name = names[id];
            var parentName = parentId == roots.FirstOrDefault() ? null : parentId is not null && names.TryGetValue(parentId, out var resolved) ? resolved : null;
            if (type == "FRAME" && node.TryGetProperty("color", out var color))
                elements.Add(Visual(name + "_Background", "Rectangle", parentName, node.GetProperty("visible").GetBoolean(), node, color.GetString()!));
            var values = Geometry(node);
            if (type == "TEXT")
            {
                values.Add(new("Text", "string", node.GetProperty("characters").GetString()!));
                values.Add(new("Font", "string", "Arial"));
                values.Add(new("FontSize", "int", "24"));
            }
            if (type == "IMAGE")
            {
                // The caller must stage the content-addressed image at this exact relative path.
                values.Add(new("SourceFile", "string", "Assets/Images/" + node.GetProperty("imageHash").GetString()![7..] + ".png"));
                values.Add(new("TextureAddress", "int", "0"));
            }
            elements.Add(new(name, type == "FRAME" ? "Container" : type == "TEXT" ? "Text" : "Sprite", parentName, node.GetProperty("visible").GetBoolean(), values));
        }
        if (errors.Count > 0) return new([], errors);
        return new([new(aliases[roots[0]], elements)], []);
    }

    private static GumElement Visual(string name, string type, string? parent, bool visible, JsonElement node, string color, bool screenOrigin = false)
    {
        var values = Geometry(node);
        if (screenOrigin)
        {
            values[0] = new("X", "float", "0");
            values[1] = new("Y", "float", "0");
        }
        values.Add(new("IsFilled", "bool", "true"));
        values.Add(new("FillRed", "int", System.Convert.ToByte(color.Substring(1, 2), 16).ToString(CultureInfo.InvariantCulture)));
        values.Add(new("FillGreen", "int", System.Convert.ToByte(color.Substring(3, 2), 16).ToString(CultureInfo.InvariantCulture)));
        values.Add(new("FillBlue", "int", System.Convert.ToByte(color.Substring(5, 2), 16).ToString(CultureInfo.InvariantCulture)));
        return new(name, type, parent, visible, values);
    }

    private static List<GumValue> Geometry(JsonElement node)
    {
        var result = new List<GumValue>();
        foreach (var key in new[] { "X", "Y", "Width", "Height" })
        {
            var n = node.GetProperty(key.ToLowerInvariant()).GetDouble();
            result.Add(new(key, "float", (n == 0 ? 0 : n).ToString("R", CultureInfo.InvariantCulture)));
        }
        return result;
    }
}
