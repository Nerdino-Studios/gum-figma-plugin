using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Threading.Tasks;

namespace GumBridge.Host;

// Thin client: all registration and filesystem writes run in the sole paired host.
public static class WorkspaceCli
{
    public static string DefaultDataDirectory => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "GumBridge");
    public static async Task<int> RunAsync(string[] args, string? localDataDirectory = null)
    {
        var sample = args.Length >= 2 && args[0] == "sample" && args[1] == "init";
        var register = args.Length >= 2 && args[0] == "workspace" && args[1] == "register";
        if (!sample && !register) return 2;
        var options = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var i = 2; i < args.Length; i += 2)
        {
            if (i + 1 >= args.Length || !new[] { "--directory", "--project", "--gumx" }.Contains(args[i]) ||
                !options.TryAdd(args[i], args[i + 1])) return 2;
        }
        if (!options.TryGetValue("--directory", out var directory) ||
            (sample && options.Count != 1) || (register && (options.Count != 3 || !options.ContainsKey("--project") || !options.ContainsKey("--gumx")))) return 2;
        try
        {
            var descriptor = Path.Combine(localDataDirectory ?? DefaultDataDirectory, "host.json");
            if (!File.Exists(descriptor)) { Console.Error.WriteLine("BRIDGE_UNAVAILABLE: start gumbridge serve first"); return 3; }
            using var json = JsonDocument.Parse(await File.ReadAllTextAsync(descriptor));
            var address = json.RootElement.GetProperty("address").GetString();
            var token = json.RootElement.GetProperty("token").GetString();
            if (address is null || token is null || !Uri.TryCreate(address, UriKind.Absolute, out var uri) ||
                uri.Scheme != "http" || uri.Host != "127.0.0.1") return 3;
            using var client = new HttpClient { BaseAddress = uri, Timeout = TimeSpan.FromSeconds(10) };
            using var request = new HttpRequestMessage(HttpMethod.Post, sample ? "/v1/local/sample" : "/v1/local/register");
            request.Headers.TryAddWithoutValidation("Authorization", "Bearer " + token);
            request.Content = JsonContent.Create(sample ? (object)new { directory } : new { directory, project = options["--project"], gumx = options["--gumx"] });
            using var response = await client.SendAsync(request);
            var body = await response.Content.ReadAsStringAsync();
            if (response.IsSuccessStatusCode) { Console.WriteLine(body); return 0; }
            Console.Error.WriteLine(body);
            return response.StatusCode == System.Net.HttpStatusCode.Unauthorized ? 3 : 1;
        }
        catch (Exception e) when (e is IOException or HttpRequestException or TaskCanceledException or JsonException or KeyNotFoundException)
        {
            Console.Error.WriteLine("BRIDGE_UNAVAILABLE: cannot contact local host");
            return 3;
        }
    }
}
