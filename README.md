# Gum Figma Plugin

## One-time setup

1. Install Git, Node.js/npm, Figma Design desktop, .NET SDK **10.0.100**, and .NET runtime **8**.
2. Clone and prepare the project:

   ```sh
   git clone --branch main https://github.com/Nerdino-Studios/gum-figma-plugin.git
   cd gum-figma-plugin
   npm ci --prefix apps/figma-plugin
   dotnet tool restore
   ```

3. In Figma, open **Plugins → Development → New Plugin**. Save its generated `manifest.json` outside this repository.
4. Build the plugin using that manifest's path:

   ```sh
   npm run setup:manifest --prefix apps/figma-plugin -- /path/to/figma-generated/manifest.json
   npm run build --prefix apps/figma-plugin
   ```

5. In Figma, choose **Plugins → Development → Import plugin from manifest…**. Select this repository's `apps/figma-plugin/manifest.json`.

## Start the bridge

1. From the repository folder, run this and leave the terminal open:

   ```sh
   dotnet run --project src/GumBridge.Host -- serve
   ```

2. **First run only:** open a second terminal in the repository folder and create the sample workspace:

   ```sh
   dotnet run --project src/GumBridge.Host -- sample init --directory "$HOME/gum-figma-sample"
   ```

## Publish your screen

1. Open the plugin in Figma. In **Connection**, click **Connect/Reconnect** if needed and select **Sample workspace**.
2. In **Publish**, choose **New design namespace** for a new design or **Continue known design** for an existing one.
3. Select a top-level frame containing your screen. Enter a screen name such as `MainMenu` and click **Bind selected frame to page**. Do this once per page.
4. Click **Publish**. If PNG approval is requested, click **Approve decorative PNG fallback**, then **Publish** again.
5. Inspect the screen in the FRB2 window. Press **Escape** to close it.

## Update your screen

1. Edit the layers inside the bound Figma frame.
2. Click **Publish** again.
