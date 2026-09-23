using System;
using System.Threading.Tasks;

namespace GumBridge.Host;

public static class Program
{
    public static async Task Main(string[] args)
    {
        if (args.Length != 1 || args[0] != "serve")
        {
            Console.Error.WriteLine("Usage: dotnet run --project src/GumBridge.Host -- serve");
            Environment.ExitCode = 2;
            return;
        }
        await using var host = await PairingHost.StartAsync();
        Console.WriteLine("Bridge listening at " + host.Address + ". Press Enter locally to authorize one plugin pairing (Ctrl+C to stop).");
        while (Console.ReadLine() is not null)
        {
            Console.WriteLine("One-time challenge (expires in 2 minutes): " + host.IssueChallengeForLocalConsent());
            Console.WriteLine("Enter again to generate another challenge.");
        }
    }
}
