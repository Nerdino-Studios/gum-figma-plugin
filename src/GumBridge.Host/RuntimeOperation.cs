using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using GumBridge.Infrastructure.Gum;

namespace GumBridge.Host;

public sealed record RuntimeReceipt(string runtimeId, string workspaceId, string snapshotId, string targetHash, string outputHash, string status);

// Read-only native staging reuses the same converter/Gum adapter as legacy artifact checks.
// It never applies generated files to the registered workspace or touches game behavior.
public sealed class RuntimeOperation
{
    private sealed record Running(PreparedDesign Design, IRuntimeSession Session, RuntimeReceipt Receipt);
    private readonly PreviewOperation preparation;
    private readonly Func<PreparedDesign, Task<IRuntimeSession>> launch;
    private readonly Dictionary<string, Running> running = new(StringComparer.Ordinal);
    public RuntimeOperation(PreviewOperation preparation, Func<PreparedDesign, Task<IRuntimeSession>>? launch = null)
    {
        this.preparation = preparation;
        this.launch = launch ?? (prepared => FrbRuntimeLauncher.LaunchAsync(prepared.Stage, prepared.ScreenName, prepared.SnapshotId));
    }
    public static string TargetHash(WorkspaceEntry entry)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData(Encoding.UTF8.GetBytes(PreviewOperation.TargetHash(entry) + ":frb2-0.6.2-preview.1:"));
        var template = Path.Combine(AppContext.BaseDirectory, "RuntimeTemplate");
        if (!Directory.Exists(template)) throw new InvalidOperationException("FRB2_TEMPLATE_MISSING");
        foreach (var path in Directory.GetFiles(template, "*", SearchOption.AllDirectories).OrderBy(path => Path.GetRelativePath(template, path), StringComparer.Ordinal))
        {
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("Linked runtime template");
            hash.AppendData(Encoding.UTF8.GetBytes(Path.GetRelativePath(template, path).Replace('\\', '/') + "\0"));
            hash.AppendData(File.ReadAllBytes(path));
        }
        return "sha256:" + Convert.ToHexStringLower(hash.GetHashAndReset());
    }
    public async Task<RuntimeReceipt> CreateAsync(WorkspaceEntry entry, string snapshotId, string expectedTargetHash)
    {
        if (TargetHash(entry) != expectedTargetHash) throw new InvalidOperationException("STALE_TARGET");
        running.TryGetValue(entry.id, out var previous);
        if (previous?.Session.IsRunning == true && previous.Receipt.snapshotId == snapshotId && previous.Receipt.targetHash == expectedTargetHash)
            return previous.Receipt;
        var prepared = await preparation.PrepareAsync(entry, snapshotId, PreviewOperation.TargetHash(entry));
        IRuntimeSession? session = null;
        try
        {
            if (prepared.ScreenCount != 1) throw new InvalidOperationException("FRB2_SCREEN_COUNT: publish one bound page at a time");
            CopyTemplate(Path.Combine(AppContext.BaseDirectory, "RuntimeTemplate"), Path.Combine(prepared.Stage, "Runtime"));
            var relativeGum = Path.GetRelativePath(Path.Combine(prepared.Stage, "Content"), prepared.GumProject).Replace('\\', '/');
            if (relativeGum.StartsWith("../", StringComparison.Ordinal)) throw new InvalidOperationException("FRB2_CONTENT_ROOT: native project must be inside Content");
            File.WriteAllText(Path.Combine(prepared.Stage, "runtime.json"), JsonSerializer.Serialize(new {
                GumProjectFile = relativeGum, ScreenName = prepared.ScreenName, Width = prepared.Width, Height = prepared.Height, SnapshotId = snapshotId }));
            session = await launch(prepared);
            if (!session.IsRunning) throw new InvalidOperationException("FRB2_START_FAILED: runtime exited before readiness");
            if (TargetHash(entry) != expectedTargetHash) throw new InvalidOperationException("STALE_TARGET");
            var receipt = new RuntimeReceipt(Guid.NewGuid().ToString("N"), entry.id, snapshotId, expectedTargetHash, prepared.OutputHash, "running");
            running[entry.id] = new Running(prepared, session, receipt);
            // Replace only a runtime owned by this host, and only after the new one has drawn.
            if (previous is not null) { await previous.Session.DisposeAsync(); previous.Design.Dispose(); }
            return receipt;
        }
        catch { if (session is not null) await session.DisposeAsync(); prepared.Dispose(); throw; }
    }
    private static void CopyTemplate(string source, string target)
    {
        if ((File.GetAttributes(source) & FileAttributes.ReparsePoint) != 0) throw new IOException("Linked runtime template");
        Directory.CreateDirectory(target);
        foreach (var path in Directory.GetFiles(source))
        {
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("Linked runtime source");
            File.Copy(path, Path.Combine(target, Path.GetFileName(path)));
        }
        foreach (var path in Directory.GetDirectories(source)) CopyTemplate(path, Path.Combine(target, Path.GetFileName(path)));
    }
    public async Task DisposeAsync()
    {
        foreach (var value in running.Values) { await value.Session.DisposeAsync(); value.Design.Dispose(); }
        running.Clear();
    }
}
