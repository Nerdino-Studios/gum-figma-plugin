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
    public async Task LocalConsentSingleUseSessionAndDeniedRequests()
    {
        await using var host = await PairingHost.StartAsync(0);
        using var client = new HttpClient { BaseAddress = new Uri(host.Address) };
        async Task<HttpResponseMessage> Send(string path, object? body = null, string? token = null, string? origin = "null")
        {
            using var request = new HttpRequestMessage(body is null ? HttpMethod.Get : HttpMethod.Post, path);
            if (body is not null) request.Content = JsonContent.Create(body);
            if (token is not null) request.Headers.TryAddWithoutValidation("Authorization", "Bearer " + token);
            if (origin is not null) request.Headers.TryAddWithoutValidation("Origin", origin);
            return await client.SendAsync(request);
        }
        Assert.Equal("127.0.0.1", new Uri(host.Address).Host);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Send("/v1/workspaces")).StatusCode);
        using var localhostHost = new HttpRequestMessage(HttpMethod.Get, "/v1/workspaces");
        localhostHost.Headers.Host = "localhost:" + new Uri(host.Address).Port;
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(localhostHost)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Send("/v1/workspaces", token: "invalid")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await Send("/v1/workspaces", origin: "https://evil.example")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await Send("/v1/files", token: "invalid")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Send("/v1/pair", new { challenge = "invalid" })).StatusCode);
        var challenge = host.IssueChallengeForLocalConsent();
        Assert.True(challenge.Length >= 64);
        var paired = await Send("/v1/pair", new { challenge });
        Assert.Equal(HttpStatusCode.OK, paired.StatusCode);
        var session = await paired.Content.ReadFromJsonAsync<Session>();
        Assert.NotNull(session);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Send("/v1/pair", new { challenge })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Send("/v1/workspaces", token: session!.token)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Send("/v1/workspaces", token: session.token + "x")).StatusCode);
        using var preflight = new HttpRequestMessage(HttpMethod.Options, "/v1/workspaces");
        preflight.Headers.TryAddWithoutValidation("Origin", "null");
        preflight.Headers.TryAddWithoutValidation("Access-Control-Request-Method", "GET");
        preflight.Headers.TryAddWithoutValidation("Access-Control-Request-Headers", "authorization");
        var allowed = await client.SendAsync(preflight);
        Assert.Equal(HttpStatusCode.NoContent, allowed.StatusCode);
        Assert.Equal("null", allowed.Headers.GetValues("Access-Control-Allow-Origin").Single());
        using var unknownPreflight = new HttpRequestMessage(HttpMethod.Options, "/v1/files");
        unknownPreflight.Headers.TryAddWithoutValidation("Origin", "null");
        unknownPreflight.Headers.TryAddWithoutValidation("Access-Control-Request-Method", "GET");
        unknownPreflight.Headers.TryAddWithoutValidation("Access-Control-Request-Headers", "authorization");
        Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(unknownPreflight)).StatusCode);
        using var hostileHost = new HttpRequestMessage(HttpMethod.Get, "/v1/workspaces");
        hostileHost.Headers.Host = "evil.example";
        Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(hostileHost)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await Send("/v1/session", new { }, session.token)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Send("/v1/workspaces", token: session.token)).StatusCode);
    }
    [Fact]
    public async Task ExpiredChallengeCannotBeRedeemed()
    {
        var now = DateTimeOffset.UtcNow;
        await using var host = await PairingHost.StartAsync(0, () => now);
        using var client = new HttpClient { BaseAddress = new Uri(host.Address) };
        var challenge = host.IssueChallengeForLocalConsent();
        now = now.AddMinutes(3);
        Assert.Equal(HttpStatusCode.Unauthorized,
            (await client.PostAsJsonAsync("/v1/pair", new { challenge })).StatusCode);
    }
    private sealed record Session(string token);
}
