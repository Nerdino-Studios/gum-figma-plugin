using System;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace GumBridge.Contracts;

/// <summary>Wire shape checks only; no conversion, hashing, or transport side effects.</summary>
public static class WireContracts
{
    private static readonly string[] Request = ["operation"];
    private static readonly string[] Snapshot = ["snapshotId", "documentNamespace", "selectedRootIds", "nodes"];
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
                TextArray(value.GetProperty("selectedRootIds")) && EmptyArray(value.GetProperty("nodes")),
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
    private static bool EmptyArray(JsonElement value) => value.ValueKind == JsonValueKind.Array && value.GetArrayLength() == 0;
}
