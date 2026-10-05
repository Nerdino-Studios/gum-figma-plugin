using System.Text.Json;
using FlatRedBall2;
using FlatRedBall2.Rendering;
using Gum;
using Gum.Managers;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using Microsoft.Xna.Framework.Input;

namespace GumBridge.Runtime;

// Handwritten runtime behavior stays separate from GumCli-generated visual code.
public sealed record RuntimeConfiguration(string GumProjectFile, string ScreenName, int Width, int Height, string SnapshotId);

public static class Program
{
    public static RuntimeConfiguration Configuration { get; private set; } = null!;
    public static string StageRoot { get; private set; } = null!;
    public static void Main()
    {
        StageRoot = Directory.GetCurrentDirectory();
        Configuration = JsonSerializer.Deserialize<RuntimeConfiguration>(File.ReadAllText("runtime.json"))
            ?? throw new InvalidOperationException("Missing trusted runtime configuration");
        using var game = new DesignGame();
        game.Run();
    }
}

public sealed class DesignGame : Game
{
    private bool ready;
    public DesignGame()
    {
        var configuration = Program.Configuration;
        _ = new GraphicsDeviceManager(this) { GraphicsProfile = GraphicsProfile.HiDef,
            PreferredBackBufferWidth = configuration.Width, PreferredBackBufferHeight = configuration.Height };
        Content.RootDirectory = "Content";
        IsMouseVisible = true;
        Window.AllowUserResizing = true;
        Window.Title = "Figma → FRB2: " + configuration.ScreenName;
    }
    protected override void Initialize()
    {
        base.Initialize();
        FlatRedBallService.Default.Initialize<DesignScreen>(this,
            new EngineInitSettings { GumProjectFile = Program.Configuration.GumProjectFile });
    }
    protected override void Update(GameTime gameTime)
    {
        if (Keyboard.GetState().IsKeyDown(Keys.Escape) || File.Exists(Path.Combine(Program.StageRoot, "runtime.stop"))) Exit();
        FlatRedBallService.Default.Update(gameTime);
        base.Update(gameTime);
    }
    protected override void Draw(GameTime gameTime)
    {
        FlatRedBallService.Default.Draw();
        base.Draw(gameTime);
        if (!ready)
        {
            // The bridge waits for an actual draw, not merely a successful process spawn.
            var receiptPath = Path.Combine(Program.StageRoot, "runtime.ready");
            File.WriteAllText(receiptPath + ".tmp", JsonSerializer.Serialize(new { Program.Configuration.SnapshotId,
                Program.Configuration.ScreenName, Program.Configuration.Width, Program.Configuration.Height }));
            File.Move(receiptPath + ".tmp", receiptPath);
            ready = true;
        }
    }
}

public sealed class DesignScreen : Screen
{
    public override DisplaySettings PreferredDisplaySettings => new() { ResolutionWidth = Program.Configuration.Width,
        ResolutionHeight = Program.Configuration.Height, PreferredWindowWidth = Program.Configuration.Width,
        PreferredWindowHeight = Program.Configuration.Height, AllowUserResizing = true };
    public override void CustomInitialize()
    {
        var native = ObjectFinder.Self.GumProjectSave?.GetScreenSave(Program.Configuration.ScreenName)
            ?? throw new InvalidOperationException("Published native screen is missing");
        AddOverlay(native.ToGraphicalUiElement());
    }
}
