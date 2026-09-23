using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Threading.Tasks;
using GumBridge.Host;
using Xunit;

namespace GumBridge.Contracts.Tests;

public sealed class WorkspaceTests
{
    [Fact]
    public async Task FreshSampleConflictAndAuthenticatedProjection()
    {
        var root = Path.Combine(OperatingSystem.IsMacOS() ? "/private/tmp" : Path.GetTempPath(), "gumbridge-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var data = Path.Combine(root, "local");
            await using var host = await PairingHost.StartAsync(0, localDataDirectory: data);
            using var client = new HttpClient { BaseAddress = new Uri(host.Address) };
            await Assert.ThrowsAsync<IOException>(() => PairingHost.StartAsync(0, localDataDirectory: data));
            var destination = Path.Combine(root, "sample");
            var source = Path.Combine(AppContext.BaseDirectory, "SampleTemplate", "Content", "GumProject", "GumProject.gumx");
            var before = File.ReadAllBytes(source);
            var challenge = host.IssueChallengeForLocalConsent();
            var session = await (await client.PostAsJsonAsync("/v1/pair", new { challenge })).Content.ReadFromJsonAsync<JsonElement>();
            var token = session.GetProperty("token").GetString()!;
            using var denied = await client.GetAsync("/v1/workspaces");
            Assert.Equal(HttpStatusCode.Unauthorized, denied.StatusCode);
            using (var pluginMutation = new HttpRequestMessage(HttpMethod.Post, "/v1/local/sample"))
            {
                pluginMutation.Headers.TryAddWithoutValidation("Authorization", "Bearer " + token);
                pluginMutation.Content = JsonContent.Create(new { directory = destination });
                Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(pluginMutation)).StatusCode);
                Assert.False(Directory.Exists(destination));
            }
            var created = await WorkspaceCli.RunAsync(new[] { "sample", "init", "--directory", destination }, data);
            Assert.Equal(0, created);
            Assert.Equal(before, File.ReadAllBytes(Path.Combine(destination, "Content", "GumProject", "GumProject.gumx")));
            Assert.Equal(before, File.ReadAllBytes(source));
            var templateRoot = Path.Combine(AppContext.BaseDirectory, "SampleTemplate");
            foreach (var file in Directory.GetFiles(templateRoot, "*", SearchOption.AllDirectories))
                Assert.Equal(File.ReadAllBytes(file), File.ReadAllBytes(Path.Combine(destination, Path.GetRelativePath(templateRoot, file))));
            Assert.Equal(1, await WorkspaceCli.RunAsync(new[] { "sample", "init", "--directory", destination }, data));
            var conflict = Path.Combine(root, "occupied");
            Directory.CreateDirectory(conflict);
            File.WriteAllText(Path.Combine(conflict, "keep.txt"), "untouched");
            Assert.Equal(1, await WorkspaceCli.RunAsync(new[] { "sample", "init", "--directory", conflict }, data));
            Assert.Equal("untouched", File.ReadAllText(Path.Combine(conflict, "keep.txt")));
            Assert.Empty(Directory.GetDirectories(root, ".gumbridge-stage-*"));
            using var request = new HttpRequestMessage(HttpMethod.Get, "/v1/workspaces");
            request.Headers.TryAddWithoutValidation("Authorization", "Bearer " + token);
            var response = await client.SendAsync(request);
            var body = await response.Content.ReadAsStringAsync();
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Contains("Sample workspace", body);
            Assert.DoesNotContain(root, body);
            Assert.DoesNotContain("token", body);
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public void SampleInitRejectsDestinationInsideBundledTemplateWithoutChangingSource()
    {
        var template = Path.Combine(AppContext.BaseDirectory, "SampleTemplate");
        var files = Directory.GetFiles(template, "*", SearchOption.AllDirectories)
            .ToDictionary(file => Path.GetRelativePath(template, file), File.ReadAllBytes);
        var directories = Directory.GetDirectories(template, "*", SearchOption.AllDirectories)
            .Select(directory => Path.GetRelativePath(template, directory)).OrderBy(name => name).ToArray();
        var data = Path.Combine(Path.GetTempPath(), "gumbridge-test-" + Guid.NewGuid().ToString("N"));
        var store = new WorkspaceStore(data);

        // This path fails safely before the fix (its parent is a file), making the red test non-destructive.
        var underFile = Path.Combine(template, "Content", "GumProject", "GumProject.gumx", "new-workspace");
        Assert.Contains("template", Assert.Throws<ArgumentException>(() => store.Init(underFile)).Message,
            StringComparison.OrdinalIgnoreCase);
        // Its parent exists: without the guard, staging here recursively copies itself into the source.
        var destination = Path.Combine(template, "new-workspace-" + Guid.NewGuid().ToString("N"));
        Assert.Contains("template", Assert.Throws<ArgumentException>(() => store.Init(destination)).Message,
            StringComparison.OrdinalIgnoreCase);
        Assert.False(Path.Exists(destination));
        Assert.Equal(directories, Directory.GetDirectories(template, "*", SearchOption.AllDirectories)
            .Select(directory => Path.GetRelativePath(template, directory)).OrderBy(name => name).ToArray());
        var after = Directory.GetFiles(template, "*", SearchOption.AllDirectories)
            .ToDictionary(file => Path.GetRelativePath(template, file), File.ReadAllBytes);
        Assert.Equal(files.Keys.OrderBy(name => name), after.Keys.OrderBy(name => name));
        foreach (var (name, bytes) in files) Assert.Equal(bytes, after[name]);
    }

    [Fact]
    public async Task ExplicitRegistrationRejectsEscapeAndDoesNotInferProject()
    {
        var root = Path.Combine(OperatingSystem.IsMacOS() ? "/private/tmp" : Path.GetTempPath(), "gumbridge-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var data = Path.Combine(root, "local");
            await using var host = await PairingHost.StartAsync(0, localDataDirectory: data);
            var projectRoot = Path.Combine(root, "existing");
            Directory.CreateDirectory(projectRoot);
            File.WriteAllText(Path.Combine(projectRoot, "app.csproj"), "<Project/>");
            File.WriteAllText(Path.Combine(projectRoot, "ui.gumx"), "<GumProject/>");
            Assert.Equal(2, await WorkspaceCli.RunAsync(new[] { "workspace", "register", "--directory", projectRoot }, data));
            Assert.Equal(1, await WorkspaceCli.RunAsync(new[] { "workspace", "register", "--directory", projectRoot, "--project", "../outside.csproj", "--gumx", "ui.gumx" }, data));
            Assert.Equal(0, await WorkspaceCli.RunAsync(new[] { "workspace", "register", "--directory", projectRoot, "--project", "app.csproj", "--gumx", "ui.gumx" }, data));
            Assert.Equal(1, await WorkspaceCli.RunAsync(new[] { "sample", "init", "--directory", Path.Combine(projectRoot, "app.csproj", "bad") }, data));
            Assert.False(Directory.Exists(Path.Combine(projectRoot, "app.csproj", "bad")));
            if (!OperatingSystem.IsWindows()) // Creating Windows junctions/symlinks requires separate OS privileges.
            {
                var linkedRoot = Path.Combine(root, "linked");
                Directory.CreateSymbolicLink(linkedRoot, projectRoot);
                Assert.Equal(1, await WorkspaceCli.RunAsync(new[] { "sample", "init", "--directory", Path.Combine(linkedRoot, "new") }, data));
                Assert.Equal(1, await WorkspaceCli.RunAsync(new[] { "workspace", "register", "--directory", linkedRoot, "--project", "app.csproj", "--gumx", "ui.gumx" }, data));
            }
        }
        finally { Directory.Delete(root, true); }
    }
}
