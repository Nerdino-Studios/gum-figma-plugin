using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace GumBridge.Host;

// Local-only host state. Never serialize roots into the plugin-facing projection.
public sealed record WorkspaceEntry(string id, string label, string kind, string root, string project, string gumx);
public sealed class WorkspaceStore
{
    private readonly string dataDirectory;
    private readonly List<WorkspaceEntry> entries;
    public WorkspaceStore(string dataDirectory)
    {
        this.dataDirectory = dataDirectory;
        var file = Path.Combine(dataDirectory, "workspaces.json");
        entries = File.Exists(file) ? JsonSerializer.Deserialize<List<WorkspaceEntry>>(File.ReadAllText(file)) ?? new() : new();
    }
    public object[] List() => entries.Select(e => (object)new { e.id, e.label, e.kind, capability = "native-gum-placeholder", ready = true }).ToArray();

    // Reject reparse points at every existing ancestor, including the destination itself.
    private static string SafePath(string input)
    {
        if (string.IsNullOrWhiteSpace(input) || !Path.IsPathFullyQualified(input)) throw new ArgumentException("Absolute path required");
        var path = Path.GetFullPath(input);
        var cursor = path;
        while (cursor != null)
        {
            if (Path.Exists(cursor) && (File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0)
                throw new ArgumentException("Linked paths are not trusted");
            cursor = Path.GetDirectoryName(cursor);
        }
        return path;
    }
    private static string ContainedFile(string root, string relative)
    {
        if (string.IsNullOrWhiteSpace(relative) || Path.IsPathRooted(relative)) throw new ArgumentException("Relative project path required");
        var full = SafePath(Path.Combine(root, relative));
        if (!full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal)) throw new ArgumentException("Path escapes root");
        if (!File.Exists(full)) throw new ArgumentException("Project file missing");
        return Path.GetRelativePath(root, full);
    }
    public WorkspaceEntry Register(string directory, string project, string gumx)
    {
        var root = SafePath(directory);
        if (!Directory.Exists(root)) throw new ArgumentException("Root does not exist");
        var csproj = ContainedFile(root, project);
        var gum = ContainedFile(root, gumx);
        if (!csproj.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase) || !gum.EndsWith(".gumx", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Explicit .csproj and .gumx required");
        if (entries.Any(e => e.root == root)) throw new ArgumentException("Root already registered");
        var entry = new WorkspaceEntry(Guid.NewGuid().ToString("N"), "Existing workspace", "existing", root, csproj, gum);
        Persist(entry);
        return entry;
    }
    public WorkspaceEntry Init(string directory)
    {
        var target = SafePath(directory);
        var template = SafePath(Path.Combine(AppContext.BaseDirectory, "SampleTemplate"));
        // Staging is created next to the target. A target inside the source would make CopyTree
        // recursively enumerate its own staged output, modifying the distributed template.
        var comparison = OperatingSystem.IsWindows() || OperatingSystem.IsMacOS()
            ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        static bool IsAtOrUnder(string path, string root, StringComparison comparison) =>
            path.Equals(root, comparison) || path.StartsWith(Path.TrimEndingDirectorySeparator(root) + Path.DirectorySeparatorChar, comparison);
        if (IsAtOrUnder(target, template, comparison) || IsAtOrUnder(template, target, comparison))
            throw new ArgumentException("Destination overlaps bundled sample template");
        if (Path.Exists(target)) throw new ArgumentException("Destination already exists; choose a new directory");
        var parent = Path.GetDirectoryName(target)!;
        if (!Directory.Exists(parent)) throw new ArgumentException("Parent directory must exist");
        if (!File.Exists(Path.Combine(template, "Content", "GumProject", "GumProject.gumx"))) throw new InvalidOperationException("Bundled native template missing");
        var stage = Path.Combine(parent, ".gumbridge-stage-" + Guid.NewGuid().ToString("N"));
        try
        {
            CopyTree(template, stage);
            // On success, a same-volume rename publishes the complete copy; never merge into an existing directory.
            if (Path.Exists(target)) throw new ArgumentException("Destination became occupied");
            Directory.Move(stage, target);
            var entry = new WorkspaceEntry(Guid.NewGuid().ToString("N"), "Sample workspace", "sample", target,
                "GumBridge.Sample.csproj", Path.Combine("Content", "GumProject", "GumProject.gumx"));
            try { Persist(entry); }
            catch { Directory.Delete(target, true); throw; }
            return entry;
        }
        finally { if (Directory.Exists(stage)) Directory.Delete(stage, true); }
    }
    private static void CopyTree(string source, string dest)
    {
        Directory.CreateDirectory(dest);
        foreach (var file in Directory.GetFiles(source))
        {
            if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new ArgumentException("Linked template file");
            File.Copy(file, Path.Combine(dest, Path.GetFileName(file)));
        }
        foreach (var child in Directory.GetDirectories(source))
        {
            if ((File.GetAttributes(child) & FileAttributes.ReparsePoint) != 0) throw new ArgumentException("Linked template directory");
            CopyTree(child, Path.Combine(dest, Path.GetFileName(child)));
        }
    }
    private void Persist(WorkspaceEntry entry)
    {
        var file = Path.Combine(dataDirectory, "workspaces.json");
        var temp = file + "." + Guid.NewGuid().ToString("N");
        try
        {
            File.WriteAllText(temp, JsonSerializer.Serialize(entries.Append(entry).ToArray()));
            File.Move(temp, file, true);
            entries.Add(entry);
        }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }
}
