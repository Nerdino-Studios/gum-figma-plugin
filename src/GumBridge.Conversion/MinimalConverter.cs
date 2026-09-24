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

/// <summary>Pure lowering of the supported v1 geometry subset; unsafe combinations block output.</summary>
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
            if (type == "FRAME" && node.GetProperty("layoutMode").GetString() != "NONE" && snapshot.GetProperty("schemaVersion").GetProperty("minor").GetInt32() < 2)
                errors.Add(new("UNSUPPORTED_FEATURE", id, "Auto layout requires v1.2 capture with verified spacing and alignment"));
            if (type == "FRAME" && id == roots.FirstOrDefault() && node.GetProperty("clipsContent").GetBoolean())
                errors.Add(new("UNSUPPORTED_FEATURE", id, "Root clipping requires a screen viewport contract"));
            if (node.TryGetProperty("rotation", out var rotation) && rotation.GetDouble() != 0 &&
                (id == roots.FirstOrDefault() || type == "TEXT" || type == "FRAME" && nodes.Any(child => child.GetProperty("parentId").ValueKind == JsonValueKind.String && child.GetProperty("parentId").GetString() == id)))
                errors.Add(new("UNSUPPORTED_FEATURE", id, "Rotated root, text or container with children has unverified interactive hit-test geometry"));
            if (node.TryGetProperty("layoutAlign", out _) && (parentId is null || !byId.TryGetValue(parentId, out var alignedParent) ||
                !alignedParent.TryGetProperty("layoutMode", out var alignedMode) || alignedMode.GetString() == "NONE"))
                errors.Add(new("UNSUPPORTED_FEATURE", id, "Per-child alignment requires an auto-layout parent"));
            if (type == "FRAME")
            {
                var mode = Property(node, "layoutMode", "NONE");
                foreach (var key in new[] { "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom" })
                    if (node.TryGetProperty(key, out var amount) && amount.GetDouble() > float.MaxValue)
                        errors.Add(new("INVALID_SNAPSHOT", id, $"{key} exceeds native Gum float range"));
                if (mode != "NONE" && new[] { ("horizontalSizing", "width", "Left", "Right"), ("verticalSizing", "height", "Top", "Bottom") }
                    .Any(axis => Property(node, axis.Item1, "FIXED") == "FIXED" && Pad(node, axis.Item3) + Pad(node, axis.Item4) > node.GetProperty(axis.Item2).GetDouble()))
                    errors.Add(new("UNSUPPORTED_FEATURE", id, "Padding exceeds fixed outer dimensions"));
                if (mode == "NONE" && HasLayout(node)) errors.Add(new("UNSUPPORTED_FEATURE", id, "Padding and alignment require auto layout"));
                if (mode != "NONE" && node.TryGetProperty("counterAxisAlignItems", out _) &&
                    Property(node, "counterAxisAlignItems", "MIN") != "MIN" &&
                    new[] { "horizontalSizing", "verticalSizing" }.Any(axis => Property(node, axis, "FIXED") == "HUG" &&
                        (axis == "horizontalSizing" ? mode == "VERTICAL" : mode == "HORIZONTAL")))
                    errors.Add(new("UNSUPPORTED_FEATURE", id, "Hug cross axis with centered/end-aligned children needs an independent content size"));
            }
            if (type == "TEXT" && node.TryGetProperty("color", out _))
                errors.Add(new("UNSUPPORTED_FEATURE", id, "Text color mapping requires a verified native rule"));
            if (type == "TEXT" && (node.GetProperty("fontFamily").GetString() != "Arial" || node.GetProperty("fontStyle").GetString() != "Regular" || node.GetProperty("fontSize").GetDouble() != 24))
                errors.Add(new("MISSING_FONT", id, "Minimal sample supports pinned Arial Regular 24 only; configure a verified font mapping"));
            if (type == "IMAGE")
            {
                if (Property(node, "horizontalSizing", "FIXED") != "FIXED" || Property(node, "verticalSizing", "FIXED") != "FIXED" || HasLimit(node))
                    errors.Add(new("UNSUPPORTED_FEATURE", id, "Responsive image dimensions and limits require verified FIT/FILL aspect-ratio rendering"));
                var hash = node.GetProperty("imageHash").GetString()!;
                var width = node.GetProperty("width").GetDouble();
                var height = node.GetProperty("height").GetDouble();
                if (imageDimensions is null || !imageDimensions.TryGetValue(hash, out var size) ||
                    !double.IsFinite(size.Width) || !double.IsFinite(size.Height) || size.Width <= 0 || size.Height <= 0 ||
                    width <= 0 || height <= 0 || size.Width > int.MaxValue || size.Height > int.MaxValue)
                    errors.Add(new("UNSUPPORTED_FEATURE", id, "Image scaling/crop requires verified positive source dimensions"));
                else if (Property(node, "scaleMode", "FIT") == "CROP" && !TryCrop(node, size, out _))
                    errors.Add(new("UNSUPPORTED_FEATURE", id, "CROP requires axis-aligned, in-bounds, integer-pixel source rectangle with matching aspect ratio"));
            }
            foreach (var axis in new[] { (Size: "Width", Position: "X", ParentSize: "width", Anchor: "horizontalAnchor", Sizing: "horizontalSizing"),
                (Size: "Height", Position: "Y", ParentSize: "height", Anchor: "verticalAnchor", Sizing: "verticalSizing") })
            {
                var sizing = Property(node, axis.Sizing, "FIXED");
                var anchor = Property(node, axis.Anchor, "MIN");
                if (id == roots.FirstOrDefault() && (sizing != "FIXED" || anchor != "MIN" || HasLimit(node)))
                    errors.Add(new("UNSUPPORTED_FEATURE", id, "Export root sizing, anchoring and limits require a viewport mapping; use fixed root geometry"));
                if (sizing == "FILL" && anchor != "STRETCH" || sizing != "FILL" && anchor == "STRETCH")
                    errors.Add(new("UNSUPPORTED_FEATURE", id, $"{axis.Sizing} and {axis.Anchor} must pair FILL with STRETCH; change sizing or constraint"));
                if (parentId is not null && byId.TryGetValue(parentId, out var sizingParent) && sizingParent.GetProperty("type").GetString() == "FRAME" &&
                    sizingParent.GetProperty("layoutMode").GetString() != "NONE")
                {
                    var mode = sizingParent.GetProperty("layoutMode").GetString();
                    var alongStack = axis.Size == "Width" ? mode == "HORIZONTAL" : mode == "VERTICAL";
                    var alignment = Property(node, "layoutAlign", "INHERIT");
                    if (alignment == "INHERIT") alignment = Property(sizingParent, "counterAxisAlignItems", "MIN");
                    if (!alongStack && Property(sizingParent, axis.Sizing, "FIXED") == "HUG" && (alignment is "CENTER" or "MAX"))
                        errors.Add(new("UNSUPPORTED_FEATURE", parentId, $"Hug cross-axis alignment dependency cycle on {axis.Size}"));
                    if (alongStack && (sizing == "FILL" || anchor != "MIN"))
                        errors.Add(new("UNSUPPORTED_FEATURE", id, "Stack-axis fill and anchors require distribution rules"));
                    if (!alongStack && anchor is "MAX" or "CENTER")
                        errors.Add(new("UNSUPPORTED_FEATURE", id, "Use layoutAlign for cross-axis alignment in auto layout"));
                    if (Property(sizingParent, axis.Sizing, "FIXED") == "HUG" && sizing == "FILL")
                        errors.Add(new("UNSUPPORTED_FEATURE", sizingParent.GetProperty("id").GetString()!, $"Hug/fill dependency cycle on {axis.Size}"));
                }
                if (sizing == "HUG" && type != "FRAME") errors.Add(new("UNSUPPORTED_FEATURE", id, "Hug sizing requires a frame with children"));
                if (sizing == "HUG" && type == "FRAME" && node.GetProperty("layoutMode").GetString() == "NONE")
                    errors.Add(new("UNSUPPORTED_FEATURE", id, "Hug sizing requires a supported stack"));
                var min = Limit(node, "min" + axis.Size);
                var max = Limit(node, "max" + axis.Size);
                if (min > max) errors.Add(new("UNSUPPORTED_FEATURE", id, $"min{axis.Size} exceeds max{axis.Size}; correct sizing limits"));
                if (new[] { "min" + axis.Size, "max" + axis.Size }.Any(key => node.TryGetProperty(key, out var limit) && limit.GetDouble() > float.MaxValue))
                    errors.Add(new("INVALID_SNAPSHOT", id, $"{axis.Size} limit exceeds native Gum float range"));
            }
            if (id == roots.FirstOrDefault())
            {
                if (node.GetProperty("layoutMode").GetString() != "NONE")
                    elements.Add(Content(names[id], node, null, screenRoot: true));
                if (!node.GetProperty("visible").GetBoolean()) errors.Add(new("UNSUPPORTED_FEATURE", id, "Invisible export root cannot be represented as a visible screen"));
                if (node.TryGetProperty("color", out var rootColor)) elements.Add(Visual(names[id] + "_Background", "Rectangle", null, true, node, rootColor.GetString()!, screenOrigin: true));
                continue;
            }
            var name = names[id];
            var parentName = parentId == roots.FirstOrDefault() ? null : parentId is not null && names.TryGetValue(parentId, out var resolved) ? resolved : null;
            if (parentId is not null && byId.TryGetValue(parentId, out var layoutParent) && layoutParent.TryGetProperty("layoutMode", out var parentLayout) && parentLayout.GetString() != "NONE")
                parentName = names[parentId] + "_Content";
            var stackParent = parentId is not null && byId.TryGetValue(parentId, out var gp) && gp.TryGetProperty("layoutMode", out var parentMode) && parentMode.GetString() != "NONE" ? gp : (JsonElement?)null;
            if (type == "FRAME" && stackParent is null && node.GetProperty("layoutMode").GetString() == "NONE" && !node.TryGetProperty("rotation", out _) && node.TryGetProperty("color", out var color))
                elements.Add(Visual(name + "_Background", "Rectangle", parentName, node.GetProperty("visible").GetBoolean(), node, color.GetString()!, parentId is not null && byId.TryGetValue(parentId, out var visualParent) ? visualParent : null));
            var values = Geometry(node, parentId is not null && byId.TryGetValue(parentId, out var geometryParent) ? geometryParent : null, stackParent);
            if (type == "TEXT")
            {
                values.Add(new("Text", "string", node.GetProperty("characters").GetString()!));
                values.Add(new("Font", "string", "Arial"));
                values.Add(new("FontSize", "int", "24"));
            }
            if (type == "FRAME" && node.GetProperty("clipsContent").GetBoolean())
                values.Add(new("ClipsChildren", "bool", "true"));
            if (node.TryGetProperty("rotation", out var angle) && angle.GetDouble() != 0)
                values.Add(new("Rotation", "float", Number(angle.GetDouble())));
            if (type == "IMAGE")
            {
                // The caller must stage the content-addressed image at this exact relative path.
                var hash = node.GetProperty("imageHash").GetString()!;
                values.Add(new("WidthUnits", "DimensionUnitType", "0"));
                values.Add(new("HeightUnits", "DimensionUnitType", "0"));
                values.Add(new("SourceFile", "string", "Assets/Images/" + hash[7..] + ".png"));
                values.Add(new("TextureAddress", "int", "0"));
                if (Property(node, "scaleMode", "FIT") == "CROP" && imageDimensions is not null &&
                    imageDimensions.TryGetValue(hash, out var cropSize) && TryCrop(node, cropSize, out var crop))
                {
                    values[^1] = new("TextureAddress", "int", "1");
                    values.Add(new("TextureLeft", "int", crop.Left.ToString(CultureInfo.InvariantCulture)));
                    values.Add(new("TextureTop", "int", crop.Top.ToString(CultureInfo.InvariantCulture)));
                    values.Add(new("TextureWidth", "int", crop.Width.ToString(CultureInfo.InvariantCulture)));
                    values.Add(new("TextureHeight", "int", crop.Height.ToString(CultureInfo.InvariantCulture)));
                }
                if (Property(node, "scaleMode", "FIT") != "CROP" && imageDimensions is not null && imageDimensions.TryGetValue(hash, out var size) &&
                    size.Width > 0 && size.Height > 0 && node.GetProperty("width").GetDouble() > 0 && node.GetProperty("height").GetDouble() > 0)
                {
                    var boxWidth = node.GetProperty("width").GetDouble();
                    var boxHeight = node.GetProperty("height").GetDouble();
                    var factor = Property(node, "scaleMode", "FIT") == "FILL"
                        ? Math.Max(boxWidth / size.Width, boxHeight / size.Height) : Math.Min(boxWidth / size.Width, boxHeight / size.Height);
                    var scaledWidth = size.Width * factor;
                    var scaledHeight = size.Height * factor;
                    if (Math.Abs(scaledWidth - boxWidth) > 0.000001 || Math.Abs(scaledHeight - boxHeight) > 0.000001)
                    {
                        if (node.TryGetProperty("rotation", out var imageRotation) && imageRotation.GetDouble() != 0)
                            errors.Add(new("UNSUPPORTED_FEATURE", id, "Rotated image with FIT/FILL viewport has unverified geometry"));
                        // Keep the Figma image bounds as a clipping viewport; center the actual sprite.
                        var viewport = values;
                        if (Property(node, "scaleMode", "FIT") == "FILL") viewport.Add(new("ClipsChildren", "bool", "true"));
                        elements.Add(new(name, "Container", parentName, node.GetProperty("visible").GetBoolean(), viewport));
                        parentName = name;
                        name += "_Image";
                        values = new List<GumValue> { new("X", "float", Number((boxWidth - scaledWidth) / 2)),
                            new("Y", "float", Number((boxHeight - scaledHeight) / 2)),
                            new("Width", "float", Number(scaledWidth)), new("Height", "float", Number(scaledHeight)),
                            new("WidthUnits", "DimensionUnitType", "0"), new("HeightUnits", "DimensionUnitType", "0"),
                            new("SourceFile", "string", "Assets/Images/" + hash[7..] + ".png"), new("TextureAddress", "int", "0") };
                    }
                }
            }
            elements.Add(new(name, type == "FRAME" ? "Container" : type == "TEXT" ? "Text" : "Sprite", parentName, node.GetProperty("visible").GetBoolean(), values));
            if (type == "FRAME" && (stackParent is not null || node.GetProperty("layoutMode").GetString() != "NONE" || node.TryGetProperty("rotation", out _)))
            {
                if (node.TryGetProperty("color", out var fill))
                    elements.Add(new(name + "_Background", "Rectangle", name, node.GetProperty("visible").GetBoolean(),
                        new List<GumValue> { new("X", "float", "0"), new("Y", "float", "0"), new("Width", "float", "0"), new("Height", "float", "0"),
                            new("WidthUnits", "DimensionUnitType", "2"), new("HeightUnits", "DimensionUnitType", "2"),
                            new("IgnoredByParentSize", "bool", "true"), new("IsFilled", "bool", "true"),
                            new("FillRed", "int", System.Convert.ToByte(fill.GetString()!.Substring(1, 2), 16).ToString(CultureInfo.InvariantCulture)),
                            new("FillGreen", "int", System.Convert.ToByte(fill.GetString()!.Substring(3, 2), 16).ToString(CultureInfo.InvariantCulture)),
                            new("FillBlue", "int", System.Convert.ToByte(fill.GetString()!.Substring(5, 2), 16).ToString(CultureInfo.InvariantCulture)) }));
                if (node.GetProperty("layoutMode").GetString() != "NONE")
                    elements.Add(Content(name, node, name));
            }
        }
        if (errors.Count > 0) return new([], errors);
        return new([new(aliases[roots[0]], elements)], []);
    }

    private static bool TryCrop(JsonElement node, (double Width, double Height) size, out (int Left, int Top, int Width, int Height) crop)
    {
        crop = default;
        var rows = node.GetProperty("imageTransform").EnumerateArray().ToArray();
        var x = rows[0].EnumerateArray().Select(v => v.GetDouble()).ToArray();
        var y = rows[1].EnumerateArray().Select(v => v.GetDouble()).ToArray();
        if (x[1] != 0 || y[0] != 0 || x[0] <= 0 || y[1] <= 0 || x[2] < 0 || y[2] < 0 ||
            x[2] + x[0] > 1 + 1e-8 || y[2] + y[1] > 1 + 1e-8 ||
            Math.Abs(node.GetProperty("width").GetDouble() / node.GetProperty("height").GetDouble() - x[0] * size.Width / (y[1] * size.Height)) > 1e-6)
            return false;
        var coordinates = new[] { x[2] * size.Width, y[2] * size.Height, x[0] * size.Width, y[1] * size.Height };
        if (coordinates.Any(value => value < 0 || value > int.MaxValue || Math.Abs(value - Math.Round(value)) > 1e-6)) return false;
        crop = ((int)Math.Round(coordinates[0]), (int)Math.Round(coordinates[1]), (int)Math.Round(coordinates[2]), (int)Math.Round(coordinates[3]));
        return crop.Width > 0 && crop.Height > 0 && crop.Left + (long)crop.Width <= size.Width && crop.Top + (long)crop.Height <= size.Height;
    }

    private static GumElement Visual(string name, string type, string? parent, bool visible, JsonElement node, string color, JsonElement? geometryParent = null, bool screenOrigin = false)
    {
        var values = Geometry(node, geometryParent);
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

    private static string Property(JsonElement node, string key, string fallback) =>
        node.TryGetProperty(key, out var value) ? value.GetString()! : fallback;

    private static bool HasLayout(JsonElement node) => new[] { "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "counterAxisAlignItems" }.Any(k => node.TryGetProperty(k, out var v) &&
        (v.ValueKind == JsonValueKind.Number ? v.GetDouble() != 0 : v.GetString() != "MIN"));
    private static double Pad(JsonElement node, string side) => node.TryGetProperty("padding" + side, out var value) ? value.GetDouble() : 0;

    private static GumElement Content(string name, JsonElement node, string? parent, bool screenRoot = false)
    {
        var horizontal = Property(node, "layoutMode", "NONE") == "HORIZONTAL";
        var values = new List<GumValue> {
            new("X", "float", Number(Pad(node, "Left"))), new("Y", "float", Number(Pad(node, "Top"))),
            new("Width", "float", Number(Property(node, "horizontalSizing", "FIXED") == "HUG" ? 0 : -Pad(node, "Left") - Pad(node, "Right"))),
            new("Height", "float", Number(Property(node, "verticalSizing", "FIXED") == "HUG" ? 0 : -Pad(node, "Top") - Pad(node, "Bottom"))),
            new("ChildrenLayout", "ChildrenLayout", horizontal ? "2" : "1"),
            new("StackSpacing", "float", Number(node.TryGetProperty("itemSpacing", out var spacing) ? spacing.GetDouble() : 0))
        };
        if (screenRoot)
        {
            values[2] = new("Width", "float", Number(node.GetProperty("width").GetDouble() - Pad(node, "Left") - Pad(node, "Right")));
            values[3] = new("Height", "float", Number(node.GetProperty("height").GetDouble() - Pad(node, "Top") - Pad(node, "Bottom")));
        }
        else foreach (var (axis, index) in new[] { ("horizontalSizing", 2), ("verticalSizing", 3) })
            values.Add(new(index == 2 ? "WidthUnits" : "HeightUnits", "DimensionUnitType", Property(node, axis, "FIXED") == "HUG" ? "4" : "2"));
        return new(name + "_Content", "Container", parent, true, values);
    }

    private static double Limit(JsonElement node, string key) => node.TryGetProperty(key, out var value) ? value.GetDouble() : key.StartsWith("min", StringComparison.Ordinal) ? 0 : double.PositiveInfinity;
    private static bool HasLimit(JsonElement node) => new[] { "minWidth", "maxWidth", "minHeight", "maxHeight" }.Any(key => node.TryGetProperty(key, out _));
    private static string Number(double n) => (n == 0 ? 0 : n).ToString("R", CultureInfo.InvariantCulture);

    private static List<GumValue> Geometry(JsonElement node, JsonElement? parent = null, JsonElement? stackParent = null)
    {
        var result = new List<GumValue>();
        foreach (var (position, size, anchorKey, sizingKey, parentKey, endUnit, centerUnit, origin) in new[] {
            ("X", "Width", "horizontalAnchor", "horizontalSizing", "width", "4", "6", "XOrigin"),
            ("Y", "Height", "verticalAnchor", "verticalSizing", "height", "5", "7", "YOrigin") })
        {
            var n = node.GetProperty(position.ToLowerInvariant()).GetDouble();
            var extent = node.GetProperty(size.ToLowerInvariant()).GetDouble();
            var anchor = Property(node, anchorKey, "MIN");
            var sizing = Property(node, sizingKey, "FIXED");
            var parentExtent = parent?.GetProperty(parentKey).GetDouble() ?? 0;
            if (stackParent is not null)
            {
                var mode = stackParent.Value.GetProperty("layoutMode").GetString();
                var along = position == "X" ? mode == "HORIZONTAL" : mode == "VERTICAL";
                if (along) { n = 0; anchor = "MIN"; }
                else
                {
                    var alignment = Property(node, "layoutAlign", "INHERIT");
                    if (alignment == "INHERIT") alignment = Property(stackParent.Value, "counterAxisAlignItems", "MIN");
                    anchor = alignment;
                    parentExtent -= position == "X" ? Pad(stackParent.Value, "Left") + Pad(stackParent.Value, "Right") : Pad(stackParent.Value, "Top") + Pad(stackParent.Value, "Bottom");
                    n = alignment == "MIN" ? 0 : alignment == "MAX" ? parentExtent - extent : (parentExtent - extent) / 2;
                }
            }
            if (anchor == "MAX") n += extent - parentExtent;
            if (anchor == "CENTER") n = n + extent / 2 - parentExtent / 2;
            result.Add(new(position, "float", Number(n)));
            if (anchor == "MAX" || anchor == "CENTER")
            {
                result.Add(new(origin, origin == "XOrigin" ? "HorizontalAlignment" : "VerticalAlignment", anchor == "MAX" ? "2" : "1"));
                result.Add(new(position + "Units", "PositionUnitType", anchor == "MAX" ? endUnit : centerUnit));
            }
            var dimension = sizing == "FILL" ? extent - parentExtent :
                sizing == "HUG" ? (position == "X" ? Pad(node, "Right") : Pad(node, "Bottom")) : extent;
            result.Add(new(size, "float", Number(dimension)));
            if (sizing == "FILL" || sizing == "HUG") result.Add(new(size + "Units", "DimensionUnitType", sizing == "HUG" ? "4" : "2"));
            foreach (var prefix in new[] { "min", "max" })
                if (node.TryGetProperty(prefix + size, out var limit))
                    result.Add(new(char.ToUpperInvariant(prefix[0]) + prefix[1..] + size, "float?", Number(limit.GetDouble())));
        }
        // Preserve the existing fixed-geometry variable order for byte-identical golden output.
        var order = new[] { "X", "Y", "Width", "Height" };
        return result.OrderBy(v => Array.IndexOf(order, v.Name) is var index && index >= 0 ? index : order.Length).ToList();
    }
}
