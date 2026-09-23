using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace GumBridge.Infrastructure.Storage;

// Host-local, scoped artifacts. An artifact ID commits to workspace, snapshot, target and PNG bytes.
public sealed class PreviewStore
{
    private readonly string root;
    public PreviewStore(string data) => root = Path.Combine(data, "previews");
    private static bool Hash(string value) => value.Length == 71 && value.StartsWith("sha256:", StringComparison.Ordinal) && value[7..].All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
    private static bool Workspace(string value) => value.Length == 32 && value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
    private static void Check(string workspace, string snapshot, string target)
    {
        if (!Workspace(workspace) || !Hash(snapshot) || !Hash(target)) throw new ArgumentException("Invalid preview identity");
    }
    private string PathFor(string workspace, string id) => Path.Combine(root, workspace, id[7..] + ".json");
    private static void Safe(string path)
    {
        for (string? cursor = path; cursor is not null; cursor = Path.GetDirectoryName(cursor))
            if (System.IO.Path.Exists(cursor) && (File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0) throw new IOException("Linked artifact storage");
    }
    private static string Digest(byte[] bytes) => "sha256:" + Convert.ToHexStringLower(SHA256.HashData(bytes));
    private sealed record Artifact(string WorkspaceId, string SnapshotId, string TargetHash, string OutputHash, string Png);
    public string Create(string workspace, string snapshot, string target, byte[] png)
    {
        Check(workspace, snapshot, target);
        if (png.Length < 24 || png.Length > 4 * 1024 * 1024 || !png.AsSpan(0, 8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }) ||
            !png.AsSpan(12, 4).SequenceEqual("IHDR"u8) || System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(png.AsSpan(16, 4)) is < 1 or > 4096 ||
            System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(png.AsSpan(20, 4)) is < 1 or > 4096) throw new ArgumentException("Invalid or oversized preview PNG");
        var output = Digest(png);
        var id = Digest(Encoding.UTF8.GetBytes(workspace + snapshot + target + output));
        var file = PathFor(workspace, id);
        Safe(file);
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(new Artifact(workspace, snapshot, target, output, Convert.ToBase64String(png)));
        if (File.Exists(file)) { Read(workspace, snapshot, target, id); return id; }
        var temp = file + "." + Guid.NewGuid().ToString("N");
        try { File.WriteAllBytes(temp, bytes); File.Move(temp, file, false); }
        finally { if (File.Exists(temp)) File.Delete(temp); }
        return id;
    }
    public byte[] Read(string workspace, string snapshot, string target, string id)
    {
        Check(workspace, snapshot, target);
        if (!Hash(id)) throw new ArgumentException("Invalid artifact ID");
        var file = PathFor(workspace, id);
        Safe(file);
        if (!File.Exists(file)) throw new ArgumentException("Unknown artifact");
        if (new FileInfo(file).Length > 6 * 1024 * 1024) throw new IOException("Oversized artifact record");
        try
        {
            var record = JsonSerializer.Deserialize<Artifact>(File.ReadAllBytes(file))!;
            var png = Convert.FromBase64String(record.Png);
            if (record.WorkspaceId != workspace || record.SnapshotId != snapshot || record.TargetHash != target ||
                record.OutputHash != Digest(png) || id != Digest(Encoding.UTF8.GetBytes(workspace + snapshot + target + record.OutputHash)))
                throw new IOException("Artifact provenance mismatch");
            return png;
        }
        catch (Exception e) when (e is JsonException or FormatException or NullReferenceException) { throw new IOException("Corrupt preview artifact", e); }
    }
    public string OutputHash(string workspace, string snapshot, string target, string id) => Digest(Read(workspace, snapshot, target, id));
}
