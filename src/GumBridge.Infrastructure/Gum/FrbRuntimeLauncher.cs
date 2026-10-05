using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace GumBridge.Infrastructure.Gum;

public interface IRuntimeSession
{
    bool IsRunning { get; }
    Task DisposeAsync();
}

// A fixed, bundled application profile. Figma data never selects commands or project files.
public static class FrbRuntimeLauncher
{
    public static async Task<IRuntimeSession> LaunchAsync(string stage, string screenName, string snapshotId)
    {
        var project = Path.Combine(stage, "Runtime", "GumBridge.Runtime.csproj");
        await BuildAsync(stage, project);
        File.Delete(Path.Combine(stage, "runtime.ready"));
        File.Delete(Path.Combine(stage, "runtime.stop"));
        var start = new ProcessStartInfo("dotnet") { WorkingDirectory = stage, UseShellExecute = false,
            RedirectStandardOutput = true, RedirectStandardError = true };
        start.ArgumentList.Add(Path.Combine(stage, "Runtime", "bin", "Debug", "net10.0", "GumBridge.Runtime.dll"));
        var process = Process.Start(start) ?? throw new InvalidOperationException("FRB2_START_FAILED: could not start the bundled application");
        var session = new ProcessSession(process, stage);
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            var ready = Path.Combine(stage, "runtime.ready");
            while (!File.Exists(ready))
            {
                if (process.HasExited) throw new InvalidOperationException("FRB2_START_FAILED: " + await session.Diagnostics());
                await Task.Delay(100, timeout.Token);
            }
            using var receipt = JsonDocument.Parse(await File.ReadAllTextAsync(ready, timeout.Token));
            if (receipt.RootElement.GetProperty("SnapshotId").GetString() != snapshotId ||
                receipt.RootElement.GetProperty("ScreenName").GetString() != screenName || process.HasExited)
                throw new InvalidOperationException("FRB2_START_FAILED: runtime identity did not match the published screen");
            return session;
        }
        catch (OperationCanceledException) { await session.DisposeAsync(); throw new InvalidOperationException("FRB2_START_TIMEOUT: no rendered frame within 30 seconds"); }
        catch { await session.DisposeAsync(); throw; }
    }
    private static async Task BuildAsync(string stage, string project)
    {
        var start = new ProcessStartInfo("dotnet") { WorkingDirectory = Path.Combine(stage, "Runtime"), UseShellExecute = false,
            RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var argument in new[] { "build", project, "--verbosity", "quiet", "-m:1", "-nodeReuse:false",
            "-p:UseSharedCompilation=false", "-p:RestoreLockedMode=true", "-p:NuGetAudit=false",
            "-p:ImportDirectoryBuildProps=false", "-p:ImportDirectoryBuildTargets=false", "-p:ImportDirectoryPackagesProps=false" })
            start.ArgumentList.Add(argument);
        using var process = Process.Start(start) ?? throw new InvalidOperationException("FRB2_BUILD_FAILED: could not start the pinned build");
        var stdout = Capture(process.StandardOutput); var stderr = Capture(process.StandardError);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(90));
        try { await process.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException) { process.Kill(true); await process.WaitForExitAsync(); throw new InvalidOperationException("FRB2_BUILD_TIMEOUT"); }
        var details = (await stdout + await stderr).Replace(stage, "[staging]");
        if (process.ExitCode != 0) throw new InvalidOperationException("FRB2_BUILD_FAILED: " + details);
    }
    private static async Task<string> Capture(TextReader reader)
    {
        var output = new StringBuilder(); var buffer = new char[1024]; int count;
        while ((count = await reader.ReadAsync(buffer)) > 0) output.Append(buffer, 0, Math.Min(count, Math.Max(0, 2048 - output.Length)));
        return output.ToString();
    }
    private sealed class ProcessSession : IRuntimeSession
    {
        private readonly Process process;
        private readonly string stage;
        private readonly Task<string> stdout, stderr;
        private bool disposed;
        public ProcessSession(Process process, string stage)
        {
            this.process = process; this.stage = stage;
            stdout = Capture(process.StandardOutput); stderr = Capture(process.StandardError);
        }
        public bool IsRunning => !disposed && !process.HasExited;
        public async Task<string> Diagnostics() => (await stdout + await stderr).Replace(stage, "[staging]");
        public async Task DisposeAsync()
        {
            if (disposed) return;
            disposed = true;
            if (!process.HasExited)
            {
                File.WriteAllText(Path.Combine(stage, "runtime.stop"), "stop");
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                try { await process.WaitForExitAsync(timeout.Token); }
                catch (OperationCanceledException) { process.Kill(true); await process.WaitForExitAsync(); }
            }
            await stdout; await stderr;
            process.Dispose();
        }
    }
}
