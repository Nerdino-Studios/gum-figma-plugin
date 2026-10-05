using System;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace GumBridge.Contracts;

/// <summary>Wire shape checks only; no conversion, hashing, or transport side effects.</summary>
public static class WireContracts
{
    private static readonly string[] Request = ["operation"];
    private static readonly string[] Snapshot = ["snapshotId", "documentNamespace", "selectedRootIds", "rootAliases", "nodes"];
    private static readonly string[] Catalog = ["catalogId", "revision", "controls"];
    private static readonly string[] Diagnostic = ["code", "severity", "message"];

    public static bool Validate(string kind, JsonElement value)
    {
        string[]? required = kind switch
        {
            "request" => Request,
            "snapshot" => Snapshot,
            "catalog" => Catalog,
            "diagnostic" => Diagnostic,
            _ => null
        };
        if (required is null || value.ValueKind != JsonValueKind.Object ||
            !required.All(key => value.TryGetProperty(key, out _)) ||
            value.EnumerateObject().Any(p => p.Name != "schemaVersion" && p.Name != "extensions" && !(kind == "snapshot" && (p.Name == "extractionDiagnostics" || p.Name == "rootMappings" || p.Name == "components")) && !required.Contains(p.Name)) ||
            !value.TryGetProperty("schemaVersion", out var version) || !ValidVersion(version)) return false;

        if (value.TryGetProperty("extensions", out var extensions) &&
            (extensions.ValueKind != JsonValueKind.Object || extensions.EnumerateObject().Any(p =>
                !Regex.IsMatch(p.Name, @"^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$", RegexOptions.CultureInvariant) || !Text(p.Value)))) return false;

        return kind switch
        {
            "request" => Text(value.GetProperty("operation")),
            "snapshot" => (!value.TryGetProperty("extractionDiagnostics", out var diagnostics) ||
                diagnostics.ValueKind == JsonValueKind.Array && diagnostics.GetArrayLength() > 0 && diagnostics.EnumerateArray().All(d => Validate("diagnostic", d) &&
                    d.GetProperty("severity").GetString() == "error" && d.GetProperty("code").GetString() == "UNSUPPORTED_FEATURE")) &&
                Text(value.GetProperty("snapshotId")) && Text(value.GetProperty("documentNamespace")) &&
                TextArray(value.GetProperty("selectedRootIds")) && ValidAliases(value.GetProperty("rootAliases"), value.GetProperty("selectedRootIds")) && NodeArray(value.GetProperty("nodes")) &&
                (!value.TryGetProperty("rootMappings", out var mappings) || version.GetProperty("minor").GetInt32() >= 4 && ValidRootMappings(mappings, value.GetProperty("selectedRootIds"), value.GetProperty("rootAliases"))) &&
                (!value.TryGetProperty("components", out var components) || version.GetProperty("minor").GetInt32() >= 5 && ValidComponents(components)) &&
                (version.GetProperty("minor").GetInt32() >= 6 || !HasShapeFallback(value)) &&
                (version.GetProperty("minor").GetInt32() >= 5 || !value.GetProperty("nodes").EnumerateArray().Any(n => n.GetProperty("type").GetString() == "INSTANCE")) &&
                (version.GetProperty("minor").GetInt32() >= 1 || !value.GetProperty("nodes").EnumerateArray().Any(HasResponsiveFields)) &&
                (version.GetProperty("minor").GetInt32() >= 2 || !value.GetProperty("nodes").EnumerateArray().Any(HasLayoutFields)) &&
                (version.GetProperty("minor").GetInt32() >= 3 || !value.GetProperty("nodes").EnumerateArray().Any(n => n.TryGetProperty("rotation", out _) || n.TryGetProperty("imageTransform", out _) || n.TryGetProperty("fallback", out _))),
            "catalog" => Text(value.GetProperty("catalogId")) && Text(value.GetProperty("revision")) &&
                EmptyArray(value.GetProperty("controls")),
            "diagnostic" => Text(value.GetProperty("code")) && Text(value.GetProperty("message")) &&
                value.GetProperty("severity").ValueKind == JsonValueKind.String &&
                new[] { "info", "warning", "error" }.Contains(value.GetProperty("severity").GetString()),
            _ => false
        };
    }

    private static bool HasShapeFallback(JsonElement snapshot)
    {
        var nodes = snapshot.GetProperty("nodes").EnumerateArray().AsEnumerable();
        if (snapshot.TryGetProperty("components", out var components))
            nodes = nodes.Concat(components.EnumerateArray().Where(c => c.GetProperty("mode").GetString() == "generate")
                .SelectMany(c => c.GetProperty("nodes").EnumerateArray()));
        return nodes.Any(n => n.TryGetProperty("fallback", out var fallback) && fallback.GetProperty("feature").GetString() == "decorative-shape");
    }

    private static bool ValidVersion(JsonElement version) =>
        version.ValueKind == JsonValueKind.Object && version.EnumerateObject().Count() == 2 &&
        version.TryGetProperty("major", out var major) && major.ValueKind == JsonValueKind.Number && major.TryGetDouble(out var number) && number == 1 &&
        version.TryGetProperty("minor", out var minor) && minor.ValueKind == JsonValueKind.Number && minor.TryGetDouble(out var revision) &&
        double.IsInteger(revision) && revision >= 0 && revision <= int.MaxValue;

    private static bool Text(JsonElement value) => value.ValueKind == JsonValueKind.String && value.GetString() is { Length: > 0 };
    private static bool TextArray(JsonElement value) => value.ValueKind == JsonValueKind.Array && value.EnumerateArray().All(Text);
    private static bool NodeArray(JsonElement value) => value.ValueKind == JsonValueKind.Array && value.EnumerateArray().All(ValidNode);
    private static bool ValidAliases(JsonElement aliases, JsonElement roots) =>
        aliases.ValueKind == JsonValueKind.Array && aliases.EnumerateArray().All(entry =>
            entry.ValueKind == JsonValueKind.Object && entry.EnumerateObject().Count() == 2 &&
            entry.TryGetProperty("rootId", out var id) && Text(id) &&
            entry.TryGetProperty("alias", out var alias) && Text(alias) &&
            roots.EnumerateArray().Any(root => root.GetString() == id.GetString())) &&
        aliases.EnumerateArray().Select(entry => entry.GetProperty("rootId").GetString()).Distinct().Count() == aliases.GetArrayLength();

    private static bool ValidRootMappings(JsonElement mappings, JsonElement roots, JsonElement aliases) =>
        mappings.ValueKind == JsonValueKind.Array && mappings.GetArrayLength() == roots.GetArrayLength() &&
        mappings.EnumerateArray().All(m => m.ValueKind == JsonValueKind.Object && m.EnumerateObject().Count() == 5 &&
            m.TryGetProperty("rootId", out var rootId) && Text(rootId) && roots.EnumerateArray().Any(r => r.GetString() == rootId.GetString()) &&
            aliases.EnumerateArray().Any(a => a.GetProperty("rootId").GetString() == rootId.GetString()) &&
            m.TryGetProperty("mode", out var mode) && mode.ValueKind == JsonValueKind.String && mode.GetString() == "generate" &&
            m.TryGetProperty("catalogId", out var catalogId) && catalogId.ValueKind == JsonValueKind.String && catalogId.GetString() == "gumbridge.builtin" &&
            m.TryGetProperty("revision", out var revision) && revision.ValueKind == JsonValueKind.String && revision.GetString() == "1.0" &&
            m.TryGetProperty("controlId", out var controlId) && controlId.ValueKind == JsonValueKind.String && controlId.GetString() == "native.frame") &&
        mappings.EnumerateArray().Select(m => m.GetProperty("rootId").GetString()).Distinct().Count() == mappings.GetArrayLength();

    private static bool ValidComponents(JsonElement components) => components.ValueKind == JsonValueKind.Array &&
        components.EnumerateArray().All(c => c.ValueKind == JsonValueKind.Object &&
            c.EnumerateObject().All(p => new[] { "id", "alias", "mode", "nodes", "controlId", "width", "height" }.Contains(p.Name)) &&
            c.TryGetProperty("id", out var id) && Text(id) && c.TryGetProperty("alias", out var alias) && Text(alias) &&
            c.TryGetProperty("mode", out var mode) && mode.ValueKind == JsonValueKind.String &&
            (mode.GetString() == "generate" && c.TryGetProperty("nodes", out var nodes) && NodeArray(nodes) &&
                !c.TryGetProperty("controlId", out _) && !c.TryGetProperty("width", out _) && !c.TryGetProperty("height", out _) ||
             mode.GetString() == "reference" && c.TryGetProperty("controlId", out var control) && Text(control) &&
                c.TryGetProperty("width", out var width) && FinitePositive(width) &&
                c.TryGetProperty("height", out var height) && FinitePositive(height) && !c.TryGetProperty("nodes", out _))) &&
        components.EnumerateArray().Select(c => c.GetProperty("id").GetString()).Distinct(StringComparer.Ordinal).Count() == components.GetArrayLength();

    private static bool FinitePositive(JsonElement value) => value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var n) && double.IsFinite(n) && n > 0;

    private static bool HasResponsiveFields(JsonElement node) => new[] { "horizontalSizing", "verticalSizing", "horizontalAnchor", "verticalAnchor", "minWidth", "maxWidth", "minHeight", "maxHeight" }.Any(key => node.TryGetProperty(key, out _));

    private static bool HasLayoutFields(JsonElement node) => new[] { "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "counterAxisAlignItems", "layoutAlign" }.Any(key => node.TryGetProperty(key, out _)) ||
        new[] { "horizontalSizing", "verticalSizing" }.Any(key => node.TryGetProperty(key, out var value) && value.GetString() == "HUG");

    private static bool ValidNode(JsonElement node)
    {
        if (node.ValueKind != JsonValueKind.Object) return false;
        string[] required = ["id", "parentId", "type", "name", "x", "y", "width", "height", "visible"];
        string[] optional = ["layoutMode", "clipsContent", "characters", "fontSize", "fontFamily", "fontStyle", "color", "imageHash", "scaleMode", "horizontalSizing", "verticalSizing", "horizontalAnchor", "verticalAnchor", "minWidth", "maxWidth", "minHeight", "maxHeight", "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "counterAxisAlignItems", "layoutAlign", "rotation", "imageTransform", "fallback", "componentId", "overrides"];
        if (!required.All(key => node.TryGetProperty(key, out _)) ||
            node.EnumerateObject().Any(p => !required.Contains(p.Name) && !optional.Contains(p.Name)) ||
            !Text(node.GetProperty("id")) || !Text(node.GetProperty("name")) ||
            !(node.GetProperty("parentId").ValueKind == JsonValueKind.Null || Text(node.GetProperty("parentId"))) ||
            node.GetProperty("visible").ValueKind is not (JsonValueKind.True or JsonValueKind.False) ||
            !new[] { "x", "y", "width", "height" }.All(key => node.GetProperty(key).ValueKind == JsonValueKind.Number &&
                node.GetProperty(key).TryGetDouble(out var n) && double.IsFinite(n) &&
                (key is "x" or "y" || n >= 0))) return false;
        foreach (var (key, allowed) in new[] { ("horizontalSizing", new[] { "FIXED", "FILL", "HUG" }), ("verticalSizing", new[] { "FIXED", "FILL", "HUG" }),
            ("horizontalAnchor", new[] { "MIN", "MAX", "CENTER", "STRETCH" }), ("verticalAnchor", new[] { "MIN", "MAX", "CENTER", "STRETCH" }) })
            if (node.TryGetProperty(key, out var value) && (value.ValueKind != JsonValueKind.String || !allowed.Contains(value.GetString()))) return false;
        if (node.TryGetProperty("imageTransform", out var transform) &&
            (transform.ValueKind != JsonValueKind.Array || transform.GetArrayLength() != 2 || transform.EnumerateArray().Any(row =>
                row.ValueKind != JsonValueKind.Array || row.GetArrayLength() != 3 || row.EnumerateArray().Any(value =>
                    value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out var n) || !double.IsFinite(n))))) return false;
        if (node.GetProperty("type").GetString() != "INSTANCE" && (node.TryGetProperty("componentId", out _) || node.TryGetProperty("overrides", out _))) return false;
        if (node.TryGetProperty("fallback", out var fallback) &&
            (node.GetProperty("type").GetString() != "IMAGE" || fallback.ValueKind != JsonValueKind.Object || fallback.EnumerateObject().Count() != 2 ||
             !fallback.TryGetProperty("feature", out var feature) || feature.ValueKind != JsonValueKind.String || !new[] { "effects/strokes", "decorative-shape" }.Contains(feature.GetString()) ||
             !fallback.TryGetProperty("fingerprint", out var fingerprint) || fingerprint.ValueKind != JsonValueKind.String ||
             !Regex.IsMatch(fingerprint.GetString()!, @"^sha256:[0-9a-f]{64}$", RegexOptions.CultureInvariant))) return false;
        if (node.TryGetProperty("rotation", out var rotation) && (rotation.ValueKind != JsonValueKind.Number || !rotation.TryGetDouble(out var angle) || !double.IsFinite(angle))) return false;
        foreach (var key in new[] { "minWidth", "maxWidth", "minHeight", "maxHeight" })
            if (node.TryGetProperty(key, out var value) && (value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out var n) || !double.IsFinite(n) || n < 0)) return false;
        foreach (var key in new[] { "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom" })
            if (node.TryGetProperty(key, out var value) && (value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out var n) || !double.IsFinite(n) || n < 0)) return false;
        foreach (var (key, allowed) in new[] { ("counterAxisAlignItems", new[] { "MIN", "CENTER", "MAX" }), ("layoutAlign", new[] { "INHERIT", "MIN", "CENTER", "MAX" }) })
            if (node.TryGetProperty(key, out var value) && (value.ValueKind != JsonValueKind.String || !allowed.Contains(value.GetString()))) return false;
        bool Has(string key) => node.TryGetProperty(key, out _);
        bool Absent(params string[] keys) => keys.All(key => !Has(key));
        bool TextProperty(string key) => Has(key) && Text(node.GetProperty(key));
        if (node.GetProperty("type").ValueKind != JsonValueKind.String ||
            Has("scaleMode") && node.GetProperty("scaleMode").ValueKind != JsonValueKind.String) return false;
        if (Has("color") && (node.GetProperty("color").ValueKind != JsonValueKind.String ||
            !Regex.IsMatch(node.GetProperty("color").GetString()!, @"^#[0-9a-f]{6}$", RegexOptions.CultureInvariant))) return false;
        return node.GetProperty("type").GetString() switch
        {
            "FRAME" => Absent("characters", "fontSize", "fontFamily", "fontStyle", "imageHash", "scaleMode", "imageTransform") &&
                TextProperty("layoutMode") && new[] { "NONE", "HORIZONTAL", "VERTICAL" }.Contains(node.GetProperty("layoutMode").GetString()) &&
                Has("clipsContent") && node.GetProperty("clipsContent").ValueKind is JsonValueKind.True or JsonValueKind.False,
            "TEXT" => Absent("layoutMode", "clipsContent", "imageHash", "scaleMode", "imageTransform", "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "counterAxisAlignItems") && Has("characters") &&
                node.GetProperty("characters").ValueKind == JsonValueKind.String && TextProperty("fontFamily") && TextProperty("fontStyle") && Has("fontSize") &&
                node.GetProperty("fontSize").ValueKind == JsonValueKind.Number && node.GetProperty("fontSize").TryGetDouble(out var size) && double.IsFinite(size) && size > 0,
            "INSTANCE" => Absent("layoutMode", "clipsContent", "characters", "fontSize", "fontFamily", "fontStyle", "color", "imageHash", "scaleMode", "imageTransform", "fallback", "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "counterAxisAlignItems",
                    "horizontalSizing", "verticalSizing", "horizontalAnchor", "verticalAnchor", "minWidth", "maxWidth", "minHeight", "maxHeight", "layoutAlign", "rotation") &&
                TextProperty("componentId") && !Has("overrides"),
            "IMAGE" => Absent("layoutMode", "clipsContent", "characters", "fontSize", "fontFamily", "fontStyle", "color", "componentId", "overrides", "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "counterAxisAlignItems") &&
                (Has("imageTransform") == (Has("scaleMode") && node.GetProperty("scaleMode").GetString() == "CROP")) && TextProperty("imageHash") &&
                Regex.IsMatch(node.GetProperty("imageHash").GetString()!, @"^sha256:[0-9a-f]{64}$", RegexOptions.CultureInvariant) &&
                TextProperty("scaleMode") && new[] { "FIT", "FILL", "CROP" }.Contains(node.GetProperty("scaleMode").GetString()),
            _ => false
        };
    }

    private static bool EmptyArray(JsonElement value) => value.ValueKind == JsonValueKind.Array && value.GetArrayLength() == 0;
}
