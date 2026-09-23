using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using System.Globalization;
using GumBridge.Contracts;

namespace GumBridge.Infrastructure.Storage;

// Host-owned data only. A transfer is never a published snapshot; the manifest is the last atomic rename.
public sealed class PublicationStore
{
    private readonly string root;
    private readonly Func<DateTimeOffset> now;
    private const int MaxBlob = 4 * 1024 * 1024;
    private const int MaxTotal = 16 * 1024 * 1024;
    private const int MaxManifest = 1024 * 1024;
    private const long MaxStored = 256L * 1024 * 1024;
    private sealed record Transfer(string WorkspaceId, string SnapshotId, DateTimeOffset Expires);
    public PublicationStore(string data, Func<DateTimeOffset> now) { root = Path.Combine(data, "publications"); this.now = now; }
    private static bool Id(string? id) => id is { Length: 32 } && id.All(Uri.IsHexDigit);
    private static bool Hash(string? hash) => hash is { Length: 71 } && hash.StartsWith("sha256:", StringComparison.Ordinal) && hash[7..].All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
    private string Workspace(string id) => Path.Combine(root, id);
    private string Stage(string workspace, string id) => Path.Combine(Workspace(workspace), "staging", id);
    private string Completed(string workspace, string id) => Path.Combine(Workspace(workspace), "completed", id + ".json");
    private string Published(string workspace, string id) => Path.Combine(Workspace(workspace), "snapshots", id[7..] + ".json");
    private static string Blob(string stage, string hash) => Path.Combine(stage, hash[7..]);
    private static void Safe(string path)
    {
        for (string? cursor = path; cursor is not null; cursor = Path.GetDirectoryName(cursor))
            if (Path.Exists(cursor) && (File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0) throw new IOException("Linked publication storage");
    }
    private static void Atomic(string path, byte[] bytes)
    {
        Safe(path);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temp = path + "." + Guid.NewGuid().ToString("N");
        try { File.WriteAllBytes(temp, bytes); File.Move(temp, path, false); }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }
    private Transfer Load(string workspace, string transferId)
    {
        if (!Id(workspace) || !Id(transferId)) throw new ArgumentException("Invalid transfer identity");
        var stage = Stage(workspace, transferId);
        Safe(stage);
        var file = Path.Combine(stage, "transfer.json");
        if (!File.Exists(file)) throw new ArgumentException("Unknown transfer");
        var transfer = JsonSerializer.Deserialize<Transfer>(File.ReadAllText(file))!;
        if (transfer.WorkspaceId != workspace || transfer.Expires <= now()) { Directory.Delete(stage, true); throw new ArgumentException("Expired transfer"); }
        return transfer;
    }
    private void Prune(string workspace)
    {
        var path = Path.Combine(Workspace(workspace), "staging");
        Safe(path);
        if (!Directory.Exists(path)) return;
        foreach (var stage in Directory.GetDirectories(path))
        {
            Safe(stage);
            var file = Path.Combine(stage, "transfer.json");
            if (!File.Exists(file) || JsonSerializer.Deserialize<Transfer>(File.ReadAllText(file))!.Expires <= now()) Directory.Delete(stage, true);
        }
    }
    public (string transferId, string[] missing) Begin(string workspace, JsonElement snapshot)
    {
        if (!Id(workspace) || !ValidSnapshot(snapshot)) throw new ArgumentException("Invalid snapshot");
        var id = snapshot.GetProperty("snapshotId").GetString()!;
        Prune(workspace);
        var completedDir = Path.Combine(Workspace(workspace), "completed");
        Safe(completedDir);
        if (Directory.Exists(completedDir))
            foreach (var record in Directory.GetFiles(completedDir, "*.json"))
                if (JsonSerializer.Deserialize<Transfer>(File.ReadAllText(record))!.Expires <= now()) File.Delete(record);
        var staging = Path.Combine(Workspace(workspace), "staging");
        if (Directory.Exists(staging) && Directory.GetDirectories(staging).Length >= 32) throw new ArgumentException("Too many staged transfers");
        var bytes = Encoding.UTF8.GetBytes(snapshot.GetRawText());
        if (bytes.Length > MaxManifest) throw new ArgumentException("Manifest budget exceeded");
        var stage = Stage(workspace, Guid.NewGuid().ToString("N"));
        Safe(stage);
        var missing = new List<string>();
        var reused = new Dictionary<string, byte[]>();
        long total = bytes.Length;
        foreach (var hash in References(snapshot))
        {
            var stored = Path.Combine(Workspace(workspace), "blobs", hash[7..]);
            Safe(stored);
            if (File.Exists(stored))
            {
                var content = File.ReadAllBytes(stored);
                if (content.Length > MaxBlob || "sha256:" + Convert.ToHexStringLower(SHA256.HashData(content)) != hash) throw new IOException("Stored blob conflict");
                total += content.Length;
                if (total > MaxTotal) throw new ArgumentException("Publication budget exceeded");
                reused.Add(hash, content);
            }
            else missing.Add(hash);
        }
        var transferBytes = JsonSerializer.SerializeToUtf8Bytes(new Transfer(workspace, id, now().AddHours(1)));
        var stagingBytes = Directory.Exists(staging) ? Directory.EnumerateFiles(staging, "*", SearchOption.AllDirectories).Sum(p => new FileInfo(p).Length) : 0;
        if (stagingBytes + total + transferBytes.Length > MaxStored) throw new ArgumentException("Staging storage budget exceeded");
        Atomic(Path.Combine(stage, "snapshot.json"), bytes);
        Atomic(Path.Combine(stage, "transfer.json"), transferBytes);
        foreach (var (hash, content) in reused) Atomic(Blob(stage, hash), content);
        return (Path.GetFileName(stage), missing.ToArray());
    }
    public void Upload(string workspace, string transferId, string hash, string encoded)
    {
        var transfer = Load(workspace, transferId);
        if (!Hash(hash) || encoded.Length > (MaxBlob + 2) / 3 * 4 + 4) throw new ArgumentException("Blob budget exceeded");
        var stage = Stage(workspace, transferId);
        using var snapshot = JsonDocument.Parse(File.ReadAllText(Path.Combine(stage, "snapshot.json")));
        if (transfer.SnapshotId != snapshot.RootElement.GetProperty("snapshotId").GetString() || !References(snapshot.RootElement).Contains(hash)) throw new ArgumentException("Unreferenced blob");
        byte[] bytes;
        try { bytes = Convert.FromBase64String(encoded); } catch (FormatException) { throw new ArgumentException("Invalid blob encoding"); }
        if (bytes.Length > MaxBlob || "sha256:" + Convert.ToHexStringLower(SHA256.HashData(bytes)) != hash) throw new ArgumentException("Corrupt blob");
        var file = Blob(stage, hash);
        Safe(file);
        if (File.Exists(file))
        {
            if (!File.ReadAllBytes(file).AsSpan().SequenceEqual(bytes)) throw new IOException("Conflicting staged blob");
            return;
        }
        var staged = Directory.GetFiles(stage).Where(p => Path.GetFileName(p).Length == 64).Sum(p => new FileInfo(p).Length);
        if (staged + bytes.Length + new FileInfo(Path.Combine(stage, "snapshot.json")).Length > MaxTotal) throw new ArgumentException("Publication budget exceeded");
        var staging = Path.Combine(Workspace(workspace), "staging");
        if (Directory.EnumerateFiles(staging, "*", SearchOption.AllDirectories).Sum(p => new FileInfo(p).Length) + bytes.Length > MaxStored)
            throw new ArgumentException("Staging storage budget exceeded");
        Atomic(file, bytes);
    }
    public (string snapshotId, string status) Finalize(string workspace, string transferId)
    {
        if (!Id(workspace) || !Id(transferId)) throw new ArgumentException("Invalid transfer identity");
        var completed = Completed(workspace, transferId);
        Safe(completed);
        if (File.Exists(completed))
        {
            var done = JsonSerializer.Deserialize<Transfer>(File.ReadAllText(completed))!;
            if (done.WorkspaceId != workspace || done.Expires <= now()) throw new ArgumentException("Expired transfer");
            var published = Published(workspace, done.SnapshotId);
            if (!File.Exists(published)) throw new IOException("Published snapshot missing");
            return (done.SnapshotId, Status(published));
        }
        var transfer = Load(workspace, transferId);
        var stage = Stage(workspace, transferId);
        var bytes = File.ReadAllBytes(Path.Combine(stage, "snapshot.json"));
        using var document = JsonDocument.Parse(bytes);
        var snapshot = document.RootElement;
        if (bytes.Length > MaxManifest || !ValidSnapshot(snapshot) || transfer.SnapshotId != snapshot.GetProperty("snapshotId").GetString()) throw new ArgumentException("Invalid staged snapshot");
        var hashes = References(snapshot).ToArray();
        long total = bytes.Length;
        foreach (var hash in hashes)
        {
            var file = Blob(stage, hash);
            Safe(file);
            if (!File.Exists(file)) throw new InvalidOperationException("Missing blob");
            var blob = File.ReadAllBytes(file);
            total += blob.Length;
            if (blob.Length > MaxBlob || total > MaxTotal || "sha256:" + Convert.ToHexStringLower(SHA256.HashData(blob)) != hash) throw new InvalidOperationException("Corrupt or oversized blob");
        }
        var dest = Published(workspace, transfer.SnapshotId);
        Safe(dest);
        var completionBytes = JsonSerializer.SerializeToUtf8Bytes(transfer);
        var workspacePathForBudget = Workspace(workspace);
        var persistedBytes = Directory.EnumerateFiles(workspacePathForBudget, "*", SearchOption.AllDirectories)
            .Where(p => !p.Contains(Path.DirectorySeparatorChar + "staging" + Path.DirectorySeparatorChar)).Sum(p => new FileInfo(p).Length);
        if (persistedBytes + completionBytes.Length > MaxStored) throw new ArgumentException("Workspace storage budget exceeded");
        if (File.Exists(dest))
        {
            foreach (var hash in hashes)
            {
                var target = Path.Combine(Workspace(workspace), "blobs", hash[7..]);
                Safe(target);
                if (!File.Exists(target) || "sha256:" + Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(target))) != hash)
                    throw new IOException("Stored blob missing or corrupt");
            }
            using var existing = JsonDocument.Parse(File.ReadAllText(dest));
            if (Canonical(existing.RootElement) != Canonical(snapshot)) throw new IOException("Immutable snapshot conflict");
        }
        else
        {
            // Bound persistent workspace storage, including orphaned blobs after interrupted publications.
            var workspacePath = Workspace(workspace);
            var existingBytes = Directory.Exists(workspacePath) ? Directory.EnumerateFiles(workspacePath, "*", SearchOption.AllDirectories)
                .Where(p => !p.Contains(Path.DirectorySeparatorChar + "staging" + Path.DirectorySeparatorChar))
                .Sum(p => new FileInfo(p).Length) : 0;
            var additional = bytes.LongLength + hashes.Where(hash => !File.Exists(Path.Combine(workspacePath, "blobs", hash[7..])))
                .Sum(hash => new FileInfo(Blob(stage, hash)).Length);
            if (existingBytes + additional + completionBytes.Length > MaxStored) throw new ArgumentException("Workspace storage budget exceeded");
            // Blobs are published first; orphaned blobs after a crash are harmless and never listed.
            foreach (var hash in hashes)
            {
                var target = Path.Combine(Workspace(workspace), "blobs", hash[7..]);
                Safe(target);
                if (File.Exists(target))
                {
                    if ("sha256:" + Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(target))) != hash) throw new IOException("Stored blob conflict");
                }
                else Atomic(target, File.ReadAllBytes(Blob(stage, hash)));
            }
            Atomic(dest, bytes);
        }
        Atomic(completed, completionBytes);
        Directory.Delete(stage, true);
        return (transfer.SnapshotId, snapshot.TryGetProperty("extractionDiagnostics", out _) ? "blocked" : "published");
    }
    public JsonDocument ReadPublished(string workspace, string snapshotId)
    {
        if (!Id(workspace) || !Hash(snapshotId)) throw new ArgumentException("Invalid publication identity");
        var file = Published(workspace, snapshotId);
        Safe(file);
        if (!File.Exists(file)) throw new ArgumentException("Snapshot not published");
        var document = JsonDocument.Parse(File.ReadAllBytes(file));
        if (!ValidSnapshot(document.RootElement)) { document.Dispose(); throw new IOException("Corrupt published snapshot"); }
        return document;
    }
    public byte[] ReadBlob(string workspace, string hash)
    {
        if (!Id(workspace) || !Hash(hash)) throw new ArgumentException("Invalid blob identity");
        var file = Path.Combine(Workspace(workspace), "blobs", hash[7..]);
        Safe(file);
        if (!File.Exists(file)) throw new ArgumentException("Missing published blob");
        var bytes = File.ReadAllBytes(file);
        if (bytes.Length > MaxBlob || "sha256:" + Convert.ToHexStringLower(SHA256.HashData(bytes)) != hash) throw new IOException("Corrupt published blob");
        return bytes;
    }
    public object[] List(string workspace)
    {
        if (!Id(workspace)) throw new ArgumentException("Invalid workspace");
        var dir = Path.Combine(Workspace(workspace), "snapshots");
        Safe(dir);
        return !Directory.Exists(dir) ? [] : Directory.GetFiles(dir, "*.json").OrderBy(p => p, StringComparer.Ordinal).Take(100).Select(p => (object)new { snapshotId = "sha256:" + Path.GetFileNameWithoutExtension(p), status = Status(p) }).ToArray();
    }
    private static string Status(string path)
    {
        Safe(path);
        using var document = JsonDocument.Parse(File.ReadAllText(path));
        return document.RootElement.TryGetProperty("extractionDiagnostics", out _) ? "blocked" : "published";
    }
    private static IEnumerable<string> References(JsonElement snapshot) => snapshot.GetProperty("nodes").EnumerateArray()
        .Where(n => n.TryGetProperty("imageHash", out _)).Select(n => n.GetProperty("imageHash").GetString()!).Distinct(StringComparer.Ordinal);
    private static bool ValidSnapshot(JsonElement snapshot)
    {
        if (!WireContracts.Validate("snapshot", snapshot) ||
            snapshot.EnumerateObject().Select(p => p.Name).Distinct().Count() != snapshot.EnumerateObject().Count()) return false;
        var id = snapshot.GetProperty("snapshotId").GetString();
        if (!Hash(id)) return false;
        var semantic = snapshot.EnumerateObject().Where(p => p.Name is not ("snapshotId" or "schemaVersion"));
        var value = "{" + string.Join(',', semantic.OrderBy(p => p.Name, StringComparer.Ordinal).Select(p => Quote(p.Name) + ":" + Canonical(p.Value))) + "}";
        if (id != "sha256:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)))) return false;
        var nodes = snapshot.GetProperty("nodes").EnumerateArray().ToArray();
        var roots = snapshot.GetProperty("selectedRootIds").EnumerateArray().Select(v => v.GetString()!).ToArray();
        if (roots.Length == 0 || nodes.Length == 0 || nodes.Length > 256 || roots.Distinct().Count() != roots.Length ||
            nodes.Any(n => n.EnumerateObject().Select(p => p.Name).Distinct().Count() != n.EnumerateObject().Count()) ||
            nodes.Select(n => n.GetProperty("id").GetString()).Distinct().Count() != nodes.Length ||
            snapshot.GetProperty("rootAliases").GetArrayLength() != roots.Length ||
            snapshot.GetProperty("rootAliases").EnumerateArray().Select(a => a.GetProperty("alias").GetString()).Distinct(StringComparer.OrdinalIgnoreCase).Count() != roots.Length ||
            snapshot.GetProperty("rootAliases").EnumerateArray().Any(a => !System.Text.RegularExpressions.Regex.IsMatch(a.GetProperty("alias").GetString()!, "^[A-Za-z_][A-Za-z0-9_]*$"))) return false;
        var seen = new HashSet<string>();
        foreach (var node in nodes)
        {
            var source = node.GetProperty("id").GetString()!;
            var parent = node.GetProperty("parentId");
            if (parent.ValueKind == JsonValueKind.Null ? !roots.Contains(source) || node.GetProperty("type").GetString() != "FRAME" :
                !seen.Contains(parent.GetString()!) || roots.Contains(source)) return false;
            seen.Add(source);
        }
        return roots.All(seen.Contains) && References(snapshot).All(Hash);
    }
    private static string Quote(string text)
    {
        var output = new StringBuilder("\"");
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (c == '"' || c == '\\') { output.Append('\\').Append(c); continue; }
            if (c < 32 || (char.IsSurrogate(c) && !(char.IsHighSurrogate(c) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1])) && !(char.IsLowSurrogate(c) && i > 0 && char.IsHighSurrogate(text[i - 1]))))
            {
                if (c == '\b') output.Append("\\b"); else if (c == '\f') output.Append("\\f");
                else if (c == '\n') output.Append("\\n"); else if (c == '\r') output.Append("\\r"); else if (c == '\t') output.Append("\\t");
                else output.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
            }
            else output.Append(c);
        }
        return output.Append('"').ToString();
    }
    private static string Number(double number)
    {
        var raw = number.ToString("R", CultureInfo.InvariantCulture).ToLowerInvariant();
        var exponentAt = raw.IndexOf('e');
        if (exponentAt < 0) return raw;
        var exponent = int.Parse(raw[(exponentAt + 1)..], CultureInfo.InvariantCulture);
        var mantissa = raw[..exponentAt];
        if (number is >= 1e-6 and < 1e21 or <= -1e-6 and > -1e21)
        {
            var negative = mantissa.StartsWith('-');
            var digits = mantissa.TrimStart('-').Replace(".", "");
            var point = mantissa.TrimStart('-').IndexOf('.');
            if (point < 0) point = digits.Length;
            point += exponent;
            return (negative ? "-" : "") + (point <= 0 ? "0." + new string('0', -point) + digits :
                point >= digits.Length ? digits + new string('0', point - digits.Length) : digits[..point] + "." + digits[point..]);
        }
        return mantissa + "e" + (exponent >= 0 ? "+" : "-") + Math.Abs(exponent).ToString(CultureInfo.InvariantCulture);
    }
    private static string Canonical(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Object => "{" + string.Join(',', value.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal).Select(p => Quote(p.Name.Replace("\r\n", "\n").Replace('\r', '\n')) + ":" + Canonical(p.Value))) + "}",
        JsonValueKind.Array => "[" + string.Join(',', value.EnumerateArray().Select(Canonical)) + "]",
        JsonValueKind.String => Quote(value.GetString()!.Replace("\r\n", "\n").Replace('\r', '\n')),
        JsonValueKind.Number => value.GetDouble() == 0 ? "0" : Number(value.GetDouble()),
        _ => value.GetRawText()
    };
}
