using System;
using System.Threading.Tasks;

namespace GumBridge.Host;

public static class Program
{
    public static async Task Main(string[] args)
    {
        if (args.Length != 1 || args[0] != "serve")
        {
            Environment.ExitCode = await WorkspaceCli.RunAsync(args);
            if (Environment.ExitCode == 2) Console.Error.WriteLine("Usage: gumbridge serve | sample init --directory <absolute-new-root> | workspace register --directory <absolute-root> --project <relative.csproj> --gumx <relative.gumx>");
            return;
        }
        await using var host = await PairingHost.StartAsync();
        Console.WriteLine("Bridge listening at " + host.Address + ". Plugin connects automatically; Ctrl+C to stop.");
        await Task.Delay(System.Threading.Timeout.InfiniteTimeSpan);
    }
}
