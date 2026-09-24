using System;
using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Linq;
using System.Threading.Tasks;
using GumBridge.Host;
using Xunit;

namespace GumBridge.Contracts.Tests;

public sealed class PairingHostTests
{
    [Fact]
    public async Task LoopbackFixedRoutesWithoutPluginSessions()
    {
        var data = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "gam240-host-" + Guid.NewGuid().ToString("N"));
        await using var host = await PairingHost.StartAsync(0, localDataDirectory: data);
        using var client = new HttpClient { BaseAddress = new Uri(host.Address) };
        Assert.Equal("127.0.0.1", new Uri(host.Address).Host);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/v1/workspaces")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsJsonAsync("/v1/pair", new { challenge = "old" })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsJsonAsync("/v1/session", new { })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/v1/files")).StatusCode);
        using var hostileOrigin = new HttpRequestMessage(HttpMethod.Get, "/v1/workspaces");
        hostileOrigin.Headers.TryAddWithoutValidation("Origin", "https://evil.example");
        Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(hostileOrigin)).StatusCode);
        using var hostileHost = new HttpRequestMessage(HttpMethod.Get, "/v1/workspaces");
        hostileHost.Headers.Host = "evil.example";
        Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(hostileHost)).StatusCode);
        using var preflight = new HttpRequestMessage(HttpMethod.Options, "/v1/workspaces");
        preflight.Headers.TryAddWithoutValidation("Origin", "null");
        preflight.Headers.TryAddWithoutValidation("Access-Control-Request-Method", "GET");
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(preflight)).StatusCode);
        using var deniedPreflight = new HttpRequestMessage(HttpMethod.Options, "/v1/local/sample");
        deniedPreflight.Headers.TryAddWithoutValidation("Origin", "null");
        deniedPreflight.Headers.TryAddWithoutValidation("Access-Control-Request-Method", "POST");
        Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(deniedPreflight)).StatusCode);
        using var pluginMutation = new HttpRequestMessage(HttpMethod.Post, "/v1/local/sample");
        pluginMutation.Headers.TryAddWithoutValidation("Origin", "null");
        pluginMutation.Content = JsonContent.Create(new { directory = "/tmp/untrusted" });
        Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(pluginMutation)).StatusCode);
    }
}
