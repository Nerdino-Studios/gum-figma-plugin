using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text;
using System.Text.RegularExpressions;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using System.Xml.Linq;
using GumBridge.Conversion;
using GumBridge.Infrastructure.Gum;
using GumBridge.Infrastructure.Storage;

namespace GumBridge.Host;

// Preview-only operation: copies a trusted sample into disposable staging and never opens a target for writing.
public sealed class PreviewOperation
{
    private readonly PublicationStore publications;
    private readonly PreviewStore artifacts;
    private readonly Func<string, string[], Task> toolRunner;
    public PreviewOperation(PublicationStore publications, PreviewStore artifacts, Func<string, string[], Task>? toolRunner = null)
    {
        this.publications = publications;
        this.artifacts = artifacts;
        this.toolRunner = toolRunner ?? Run;
    }
    public static string TargetHash(WorkspaceEntry entry)
    {
        if (entry.kind != "sample") throw new ArgumentException("Preview requires the bundled Sample workspace");
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData(System.Text.Encoding.UTF8.GetBytes(entry.id + ":gumcli-2026.9.2.1:"));
        foreach (var file in SafeFiles(entry.root)
            .OrderBy(p => Path.GetRelativePath(entry.root, p), StringComparer.Ordinal))
        {
            if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new IOException("Linked sample input");
            hash.AppendData(System.Text.Encoding.UTF8.GetBytes(Path.GetRelativePath(entry.root, file).Replace('\\', '/') + "\0"));
            hash.AppendData(File.ReadAllBytes(file));
        }
        return "sha256:" + Convert.ToHexStringLower(hash.GetHashAndReset());
    }
    public async Task<(string artifactId, string outputHash, string targetHash)> CreateAsync(WorkspaceEntry entry, string snapshotId, string expectedTargetHash)
    {
        var target = TargetHash(entry);
        if (target != expectedTargetHash) throw new InvalidOperationException("STALE_TARGET");
        using var document = publications.ReadPublished(entry.id, snapshotId);
        var snapshot = document.RootElement;
        var sizes = new Dictionary<string, (double Width, double Height)>();
        var blobs = new Dictionary<string, byte[]>();
        long decodedPixels = 0;
        foreach (var node in snapshot.GetProperty("nodes").EnumerateArray())
            if (node.TryGetProperty("imageHash", out var image))
            {
                var hash = image.GetString()!;
                var bytes = publications.ReadBlob(entry.id, hash);
                if (bytes.Length < 24 || !bytes.AsSpan(0, 8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 })) throw new ArgumentException("INVALID_IMAGE");
                if (!blobs.ContainsKey(hash))
                {
                    var imageWidth = System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(16, 4));
                    var imageHeight = System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(20, 4));
                    decodedPixels = ValidateImagePixels(imageWidth, imageHeight, decodedPixels);
                    sizes[hash] = (imageWidth, imageHeight);
                    blobs[hash] = bytes;
                }
            }
        var fonts = ReadFontMappings(entry);
        foreach (var node in snapshot.GetProperty("nodes").EnumerateArray())
            if (node.GetProperty("type").GetString() == "TEXT")
            {
                var key = new FontKey(node.GetProperty("fontFamily").GetString()!, node.GetProperty("fontStyle").GetString()!,
                    node.GetProperty("fontSize").GetDouble() is var size && size > 0 && size <= 256 && size == Math.Truncate(size) ? (int)size : 0);
                if (fonts.TryGetValue(key, out var font))
                    FontAssetValidator.Validate(Path.Combine(Path.GetDirectoryName(Path.Combine(entry.root, entry.gumx))!, font.Path),
                        node.GetProperty("characters").GetString(), key.Size);
            }
        var converted =  MinimalConverter.Convert(snapshot, sizes, fonts);
        if (converted.Diagnostics.Count > 0 || converted.Screens.Count != 1) throw new InvalidOperationException("VALIDATION_FAILED: " + string.Join(';', converted.Diagnostics.Select(d => d.Code)));
        var screen = converted.Screens[0];
        var root = snapshot.GetProperty("nodes")[0];
        var width = (int)root.GetProperty("width").GetDouble();
        var height = (int)root.GetProperty("height").GetDouble();
        if (width is < 1 or > 2048 || height is < 1 or > 2048 || (long)width * height > 4194304) throw new ArgumentException("Preview dimensions out of bounds");
        var stage = Path.Combine(Path.GetTempPath(), "gumbridge-preview-" + Guid.NewGuid().ToString("N"));
        try
        {
            CopyTree(entry.root, stage);
            var manifest = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", ".config", "dotnet-tools.json"));
            Directory.CreateDirectory(Path.Combine(stage, ".config"));
            File.Copy(manifest, Path.Combine(stage, ".config", "dotnet-tools.json"));
            var gumx = Path.Combine(stage, entry.gumx);
            // Never honor a target's codegen destination, even if it is absolute or traverses out of staging.
            var settingsPath = Path.Combine(Path.GetDirectoryName(gumx)!, "ProjectCodeSettings.codsj");
            if (!File.Exists(settingsPath)) throw new InvalidOperationException("Missing code generation settings");
            {
                var settings = JsonNode.Parse(File.ReadAllText(settingsPath)) as JsonObject
                    ?? throw new InvalidOperationException("Invalid code generation settings");
                var generated = Path.Combine(stage, "PreviewGenerated");
                Directory.CreateDirectory(generated);
                settings["CodeProjectRoot"] = Path.GetRelativePath(Path.GetDirectoryName(gumx)!, generated).Replace('\\', '/') + "/";
                File.WriteAllText(settingsPath, settings.ToJsonString());
            }
            var project = XDocument.Load(gumx);
            if (project.Root?.Element("FontGenerator")?.Value != "KernSmith") throw new InvalidOperationException("TOOLCHAIN_MISMATCH: expected KernSmith");
            var references = project.Root!.Elements("ScreenReference").ToArray();
            foreach (var reference in references) reference.Remove();
            project.Root.Add(new XElement("ScreenReference", new XAttribute("Name", screen.Name)));
            project.Save(gumx);
            var screens = Path.Combine(Path.GetDirectoryName(gumx)!, "Screens");
            Directory.CreateDirectory(screens);
            File.WriteAllText(Path.Combine(screens, screen.Name + ".gusx"), GumModelSerializer.Serialize(screen));
            foreach (var (hash, bytes) in blobs)
            {
                var path = Path.Combine(Path.GetDirectoryName(gumx)!, "Assets", "Images", hash[7..] + ".png");
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.WriteAllBytes(path, bytes);
            }
            await toolRunner(stage, ["check", gumx]);
            await toolRunner(stage, ["fonts", gumx]);
            if (snapshot.GetProperty("nodes").EnumerateArray().Any(node => node.GetProperty("type").GetString() == "TEXT" &&
                node.GetProperty("fontFamily").GetString() == "Arial" && node.GetProperty("fontStyle").GetString() == "Regular" &&
                node.GetProperty("fontSize").GetDouble() == 24 && !fonts.ContainsKey(new FontKey("Arial", "Regular", 24))) &&
                !File.Exists(Path.Combine(Path.GetDirectoryName(gumx)!, "FontCache", "Font24Arial.fnt"))) throw new InvalidOperationException("MISSING_FONT");
            await toolRunner(stage, ["codegen", gumx]);
            var png = Path.Combine(stage, "result.png");
            await toolRunner(stage, ["screenshot", gumx, screen.Name, "--output", png, "--width", width.ToString(), "--height", height.ToString(), "--backend", "monogame"]);
            if (TargetHash(entry) != target) throw new InvalidOperationException("STALE_TARGET");
            var artifactId = artifacts.Create(entry.id, snapshotId, target, File.ReadAllBytes(png));
            return (artifactId, artifacts.OutputHash(entry.id, snapshotId, target, artifactId), target);
        }
        finally { if (Directory.Exists(stage)) Directory.Delete(stage, true); }
    }
    // Explicit workspace-local licensed bitmap fonts; .fnt + PNG pages are copied into staging with the sample.
    // Font mappings and all asset bytes participate in TargetHash. Never resolve a Figma-supplied path.
    public static IReadOnlyDictionary<FontKey, FontAsset> ReadFontMappings(WorkspaceEntry entry)
    {
        var result = new Dictionary<FontKey, FontAsset>();
        var config = Path.Combine(entry.root, "font-mappings.json");
        if (!File.Exists(config)) return result;
        if (new FileInfo(config).Length > 65536) throw new InvalidOperationException("MISSING_FONT: mapping file too large");
        using var json = JsonDocument.Parse(File.ReadAllBytes(config));
        if (json.RootElement.ValueKind != JsonValueKind.Array || json.RootElement.GetArrayLength() > 64)
            throw new InvalidOperationException("MISSING_FONT: invalid mapping list");
        var gumDirectory = Path.GetDirectoryName(Path.Combine(entry.root, entry.gumx))!;
        foreach (var mapping in json.RootElement.EnumerateArray())
        {
            if (mapping.ValueKind != JsonValueKind.Object || mapping.EnumerateObject().Count() != 5 ||
                !new[] { "family", "style", "size", "file", "sha256" }.All(k => mapping.TryGetProperty(k, out _)))
                throw new InvalidOperationException("MISSING_FONT: invalid mapping fields");
            var familyValue = mapping.GetProperty("family");
            var styleValue = mapping.GetProperty("style");
            var fileValue = mapping.GetProperty("file");
            var digestValue = mapping.GetProperty("sha256");
            if (familyValue.ValueKind != JsonValueKind.String || styleValue.ValueKind != JsonValueKind.String ||
                fileValue.ValueKind != JsonValueKind.String || digestValue.ValueKind != JsonValueKind.String)
                throw new InvalidOperationException("MISSING_FONT: invalid mapping value types");
            var family = familyValue.GetString();
            var style = styleValue.GetString();
            var size = mapping.GetProperty("size");
            var file = fileValue.GetString();
            var digest = digestValue.GetString();
            if (string.IsNullOrWhiteSpace(family) || string.IsNullOrWhiteSpace(style) || family.Length > 100 || style.Length > 100 ||
                size.ValueKind != JsonValueKind.Number || !size.TryGetInt32(out var points) || points is < 1 or > 256 ||
                file is null || !Regex.IsMatch(file, @"^Assets/Fonts/[A-Za-z0-9_-]+\.fnt$") ||
                digest is null || !Regex.IsMatch(digest, @"^sha256:[0-9a-f]{64}$"))
                throw new InvalidOperationException("MISSING_FONT: invalid font mapping");
            var path = Path.Combine(gumDirectory, file);
            if (!File.Exists(path) || (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0 ||
                new FileInfo(path).Length is < 1 or > 1048576 ||
                "sha256:" + Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(path))) != digest)
                throw new InvalidOperationException("MISSING_FONT: font descriptor missing or hash mismatch");
            FontAssetValidator.Validate(path, expectedSize: points);
            if (!result.TryAdd(new FontKey(family, style, points), new FontAsset(file, digest)))
                throw new InvalidOperationException("MISSING_FONT: duplicate font mapping");
        }
        return result;
    }
    public static void ValidateImagePixels(IEnumerable<(uint Width, uint Height)> images)
    {
        long total = 0;
        foreach (var (width, height) in images) total = ValidateImagePixels(width, height, total);
    }
    private static long ValidateImagePixels(uint width, uint height, long total)
    {
        // Each decoded RGBA image is at most 16 MiB; the unique source set at most 64 MiB.
        if (width is < 1 or > 4096 || height is < 1 or > 4096 ||
            (long)width * height > 4194304 || total + (long)width * height > 16777216)
            throw new ArgumentException("IMAGE_PIXELS_EXCEEDED");
        return total + (long)width * height;
    }
    private static IEnumerable<string> SafeFiles(string directory)
    {
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) throw new IOException("Linked sample directory");
        foreach (var file in Directory.GetFiles(directory))
        {
            if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new IOException("Linked sample file");
            yield return file;
        }
        foreach (var child in Directory.GetDirectories(directory))
            if (Path.GetFileName(child) is not ("bin" or "obj" or "FontCache"))
                foreach (var file in SafeFiles(child)) yield return file;
    }
    private static void CopyTree(string source, string destination)
    {
        if ((File.GetAttributes(source) & FileAttributes.ReparsePoint) != 0) throw new IOException("Linked sample root");
        Directory.CreateDirectory(destination);
        foreach (var file in Directory.GetFiles(source))
        {
            if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new IOException("Linked sample file");
            File.Copy(file, Path.Combine(destination, Path.GetFileName(file)));
        }
        foreach (var directory in Directory.GetDirectories(source))
            if (Path.GetFileName(directory) is not ("bin" or "obj" or "FontCache")) CopyTree(directory, Path.Combine(destination, Path.GetFileName(directory)));
    }
    public static string ErrorCode(string message)
    {
        var prefix = message.Split(':', 2)[0];
        return Regex.IsMatch(prefix, "^[A-Z_]{1,40}$") ? prefix : "VALIDATION_FAILED";
    }
    public static PreviewToolFailure ToolFailure(string step, string stdout, string stderr)
    {
        var source = string.IsNullOrWhiteSpace(stderr) ? stdout : stderr;
        source = Regex.Replace(source, @"(?i)(Authorization\s*:\s*Bearer\s+|Bearer\s+|challenge\s*[:=]\s*)[^\s]+", "$1[redacted]");
        const int limit = 2048;
        var truncated = source.Length > limit;
        return new PreviewToolFailure("gumcli " + step, source[..Math.Min(source.Length, limit)] + (truncated ? " [truncated]" : ""));
    }
    private static async Task<(string Text, bool Truncated)> Capture(System.IO.TextReader reader)
    {
        var result = new StringBuilder();
        var buffer = new char[2048];
        var truncated = false;
        int count;
        while ((count = await reader.ReadAsync(buffer)) > 0)
        {
            if (result.Length + count > 8192) truncated = true;
            result.Append(buffer, 0, Math.Min(count, Math.Max(0, 8192 - result.Length)));
        }
        return (result.ToString(), truncated);
    }
    private static async Task Run(string stage, params string[] args)
    {
        using var process = new Process { StartInfo = new ProcessStartInfo("dotnet") { WorkingDirectory = stage, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false } };
        process.StartInfo.Environment["DOTNET_ROLL_FORWARD"] = "Major";
        process.StartInfo.ArgumentList.Add("tool"); process.StartInfo.ArgumentList.Add("run"); process.StartInfo.ArgumentList.Add("gumcli"); process.StartInfo.ArgumentList.Add("--");
        foreach (var arg in args) process.StartInfo.ArgumentList.Add(arg);
        process.Start();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(90));
        var stdout = Capture(process.StandardOutput); var stderr = Capture(process.StandardError);
        try { await process.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException) { process.Kill(true); throw new InvalidOperationException("TOOLCHAIN_TIMEOUT: gumcli " + args[0]); }
        var outText = await stdout; var errText = await stderr;
        if (process.ExitCode != 0)
        {
            var failure = ToolFailure(args[0], outText.Text, errText.Text);
            if ((string.IsNullOrWhiteSpace(errText.Text) ? outText.Truncated : errText.Truncated) && !failure.Details.Contains("[truncated]"))
                failure = new PreviewToolFailure(failure.Stage, failure.Details + " [truncated]");
            throw failure;
        }
    }
}

public sealed class PreviewToolFailure : InvalidOperationException
{
    public string Code => "VALIDATION_FAILED";
    public string Stage { get; }
    public string Details { get; }
    public PreviewToolFailure(string stage, string details) : base("VALIDATION_FAILED: " + stage + ": " + details)
    {
        Stage = stage;
        Details = details;
    }
}
