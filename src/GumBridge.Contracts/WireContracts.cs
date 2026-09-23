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
            value.EnumerateObject().Any(p => p.Name != "schemaVersion" && p.Name != "extensions" && !required.Contains(p.Name)) ||
            !value.TryGetProperty("schemaVersion", out var version) || !ValidVersion(version)) return false;

        if (value.TryGetProperty("extensions", out var extensions) &&
            (extensions.ValueKind != JsonValueKind.Object || extensions.EnumerateObject().Any(p =>
                !Regex.IsMatch(p.Name, @"^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$", RegexOptions.CultureInvariant) || !Text(p.Value)))) return false;

        return kind switch
        {
            "request" => Text(value.GetProperty("operation")),
            "snapshot" => Text(value.GetProperty("snapshotId")) && Text(value.GetProperty("documentNamespace")) &&
                TextArray(value.GetProperty("selectedRootIds")) && ValidAliases(value.GetProperty("rootAliases"), value.GetProperty("selectedRootIds")) && NodeArray(value.GetProperty("nodes")),
            "catalog" => Text(value.GetProperty("catalogId")) && Text(value.GetProperty("revision")) &&
                EmptyArray(value.GetProperty("controls")),
            "diagnostic" => Text(value.GetProperty("code")) && Text(value.GetProperty("message")) &&
                value.GetProperty("severity").ValueKind == JsonValueKind.String &&
                new[] { "info", "warning", "error" }.Contains(value.GetProperty("severity").GetString()),
            _ => false
        };
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

    private static bool ValidNode(JsonElement node)
    {
        if (node.ValueKind != JsonValueKind.Object) return false;
        string[] required = ["id", "parentId", "type", "name", "x", "y", "width", "height", "visible"];
        string[] optional = ["layoutMode", "clipsContent", "characters", "fontSize", "fontFamily", "fontStyle", "color", "imageHash", "scaleMode"];
        if (!required.All(key => node.TryGetProperty(key, out _)) ||
            node.EnumerateObject().Any(p => !required.Contains(p.Name) && !optional.Contains(p.Name)) ||
            !Text(node.GetProperty("id")) || !Text(node.GetProperty("name")) ||
            !(node.GetProperty("parentId").ValueKind == JsonValueKind.Null || Text(node.GetProperty("parentId"))) ||
            node.GetProperty("visible").ValueKind is not (JsonValueKind.True or JsonValueKind.False) ||
            !new[] { "x", "y", "width", "height" }.All(key => node.GetProperty(key).ValueKind == JsonValueKind.Number &&
                node.GetProperty(key).TryGetDouble(out var n) && double.IsFinite(n) &&
                (key is "x" or "y" || n >= 0))) return false;
        bool Has(string key) => node.TryGetProperty(key, out _);
        bool Absent(params string[] keys) => keys.All(key => !Has(key));
        bool TextProperty(string key) => Has(key) && Text(node.GetProperty(key));
        if (node.GetProperty("type").ValueKind != JsonValueKind.String) return false;
        if (Has("color") && (node.GetProperty("color").ValueKind != JsonValueKind.String ||
            !Regex.IsMatch(node.GetProperty("color").GetString()!, @"^#[0-9a-f]{6}$", RegexOptions.CultureInvariant))) return false;
        return node.GetProperty("type").GetString() switch
        {
            "FRAME" => Absent("characters", "fontSize", "fontFamily", "fontStyle", "imageHash", "scaleMode") &&
                TextProperty("layoutMode") && new[] { "NONE", "HORIZONTAL", "VERTICAL" }.Contains(node.GetProperty("layoutMode").GetString()) &&
                Has("clipsContent") && node.GetProperty("clipsContent").ValueKind is JsonValueKind.True or JsonValueKind.False,
            "TEXT" => Absent("layoutMode", "clipsContent", "imageHash", "scaleMode") && Has("characters") &&
                node.GetProperty("characters").ValueKind == JsonValueKind.String && TextProperty("fontFamily") && TextProperty("fontStyle") && Has("fontSize") &&
                node.GetProperty("fontSize").ValueKind == JsonValueKind.Number && node.GetProperty("fontSize").TryGetDouble(out var size) && double.IsFinite(size) && size > 0,
            "IMAGE" => Absent("layoutMode", "clipsContent", "characters", "fontSize", "fontFamily", "fontStyle", "color") && TextProperty("imageHash") &&
                Regex.IsMatch(node.GetProperty("imageHash").GetString()!, @"^sha256:[0-9a-f]{64}$", RegexOptions.CultureInvariant) &&
                TextProperty("scaleMode") && new[] { "FIT", "FILL" }.Contains(node.GetProperty("scaleMode").GetString()),
            _ => false
        };
    }

    private static bool EmptyArray(JsonElement value) => value.ValueKind == JsonValueKind.Array && value.GetArrayLength() == 0;
}
