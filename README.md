# Gum Figma Plugin

A visual Figma plugin and local C#/.NET 10 bridge for turning Figma designs into native Gum UI. External coding agents use MCP or a CLI to request deterministic conversion and connect the generated UI to application behavior.

**Status: Connection + Publish workflow with one designated screen frame per Figma page and a bundled standalone FRB2 test application.** Publish captures the bound frame regardless of selection, publishes its immutable snapshot, and opens the native Gum screen in FRB2. No screenshot panel is required. The macOS arm64 integration test runs real pinned Gum validation/font generation/code generation, compiles generated C# with the FRB2 application, and waits for its first rendered frame. Target workspace files are unchanged; this is an isolated test run, not managed application deployment.

Namespace-scoped aliases, shared generated components and registered references are supported. Frames, text, images, solid rectangles, layout and clipping retain their supported slice and blocking diagnostics. Eligible decorative polygons and unsupported decorative rectangle paints/corners require explicit per-node PNG approval. Button/TextBox/ScrollViewer adapters, sample-design creation, broad custom catalogs, managed updates and full behavior integration remain pending. A Sample workspace must still be initialized explicitly through the CLI. Real Figma desktop checks verified the bound screen and the polygon approval prompt. **UNRUN:** that design's approved PNG export and complete Publish-to-FRB2 flow, Figma-to-FRB2 visual comparison, handwritten click-handler verification and all Windows checks. See [compatibility](docs/compatibility.md).

## How to use this

1. Install the [development plugin](#install-the-development-plugin-once) once.
2. Follow [Publish a page into FRB2](#publish-a-page-into-frb2) to start the host and bind your screen.
3. After editing the design, click **Publish** again to run the updated screen.

This is a **one-way Figma → Gum/FRB2 converter**. It cannot open an existing Gum project inside Figma. Publish runs an isolated test application; it does not update a production game or the registered sample's files. Supported visuals become native Gum elements. A button-shaped component is currently a reusable visual component, without automatic click, hover, focus, or text-input behavior.

### Requirements

- Figma Design desktop and a graphics-capable desktop session.
- .NET SDK **10.0.100** (`global.json`) and **.NET runtime 8** for the pinned Gum tooling.
- Node.js and npm for building the development plugin.
- NuGet access for restoring Gum tooling and the pinned FRB2 runtime packages.

Python 3 is needed only for the architecture checks. macOS arm64 has native runtime test evidence; Windows checks remain unrun. No existing game or production Figma design is required.

## Development documentation

The [approved implementation specification](docs/figma-gum-plugin-spec.md) defines the architecture, ownership rules and acceptance requirements. Repository guidance for coding agents is in [AGENTS.md](AGENTS.md). The specification is authoritative; this README describes how to use the current implementation.

## Developer checks

Install the .NET SDK pinned in `global.json` (10.0.100), Node.js and npm, and Python 3. Run from the repository root:

```sh
dotnet build GumBridge.sln
python3 -m unittest discover -s tests/architecture -v
npm ci --prefix apps/figma-plugin
npm run typecheck --prefix apps/figma-plugin
```

`dotnet test GumBridge.sln` runs the wire and pairing-host integration tests; the architecture gate is the Python unittest command above. The pinned TypeScript and official Figma typings are only compilation dependencies, not evidence of a real Figma client test. For the native Gum smoke check, install .NET runtime 8 and run `dotnet tool restore` followed by `scripts/check-native-sample.sh` in a graphics-capable session. See [compatibility](docs/compatibility.md) for verified macOS results and unrun Windows checks.

## Install the development plugin once

**One-time developer registration (not an end-user install step):** In Figma Design desktop, create a **New Plugin** from the Development plugins menu and save its Figma-generated `manifest.json` outside this repo. From the repository root run:

```sh
npm ci --prefix apps/figma-plugin
npm run setup:manifest --prefix apps/figma-plugin -- /absolute/path/to/figma-generated/manifest.json
npm run build --prefix apps/figma-plugin
```

Then choose **Plugins → Development → Import plugin from manifest…** and select this repository's `apps/figma-plugin/manifest.json`; rerun that development plugin after rebuilding. The setup command imports only the legitimate Figma-assigned ID, never its entry paths or network permissions. It refuses missing/invalid IDs and conflicting existing IDs; repeated setup with the same ID leaves the local manifest untouched. This ignored local ID must remain stable for document plugin metadata. The portable checked-in `manifest.template.json` has no ID; building without registration produces an ID-free manifest but cannot enable plugin-data persistence. If you launch without an ID, the panel shows setup instructions instead of crashing. Do not publish or distribute an ID-free manifest. End users do **not** run this developer registration command; distributing/installing a finished plugin is a separate release workflow not yet implemented or tested.

Run `npm run typecheck --prefix apps/figma-plugin` and `npm test --prefix apps/figma-plugin` to validate local changes. A rebuild preserves a current ignored local manifest byte-for-byte, including its Figma-assigned ID; it upgrades only the previously known stale loopback permission. Never commit `manifest.json` or credentials. See [compatibility](docs/compatibility.md) for real Figma-client evidence and remaining checks.

## Publish a page into FRB2

1. Start the host from the repository root and leave its terminal open:
   ```sh
   dotnet tool restore
   dotnet run --project src/GumBridge.Host -- serve
   ```
2. Once, in a second terminal, initialize a Sample workspace in a new absolute directory:
   ```sh
   dotnet run --project src/GumBridge.Host -- sample init --directory /absolute/new/sample
   ```
   Replace `/absolute/new/sample` with an absolute path to a directory that does not exist yet. Initialization registers it with the running host. Keep this workspace outside the repository. Reuse it on later sessions; do not initialize it again.
3. Open the development plugin in Figma. **Connection** checks the host automatically; use **Connect to local bridge** or **Reconnect to local bridge** if necessary and choose **Sample workspace**. Rebuild/reload the plugin only when its code changes.
4. In **Publish**, choose **New design namespace** for a new design, or **Continue known design** when reopening the same design. Select one top-level frame, enter a stable screen name such as `MainMenu`, and click **Bind selected frame to page**. Put the screen's layers inside this frame. Each page has its own binding; other page layers stay outside that screen unless referenced as dependencies. An existing binding does not need to be recreated.
5. Click **Publish**. The full bound screen opens in the standalone FRB2 window even if nothing is selected. The plugin reports **Running in FRB2** after the application draws its first frame. If a decorative PNG approval is offered, review it, click **Approve decorative PNG fallback for …**, and click **Publish** again. Each approval applies to the exact captured decoration; changing it can require approval again.

### Edit and test again

1. Edit layers inside the bound Figma frame.
2. Click **Publish** to replace the running screen. An identical publish reuses the matching run.
3. Inspect the screen in the FRB2 window. Use **Escape** to close that window.

Close FRB2 with **Escape** when finished, then stop the bridge process in your terminal or process manager. Reopen the plugin and choose **Continue known design** to retain the existing namespace and mappings. Frame/page display renames preserve the screen binding.

For a first test, use a top-level frame containing one solid rectangle. Add text, images, reusable components and more complex layout after that screen runs. PNG fallback keeps the source shape editable in Figma, but the Gum Sprite loses shape editability and resolution independence.

### If Publish is blocked

| Message or symptom | Action |
|---|---|
| Offline / cannot connect | Start the host, then click Connect or Reconnect. The fixed bridge address is `127.0.0.1:48931`. |
| No workspaces registered | Run the one-time `sample init` command above, then reconnect. |
| Missing or moved screen frame | Restore the bound frame as a top-level frame on its original page. |
| Unsupported layer / PNG approval | Use the reported layer ID and property to find the source. Approve an offered decorative fallback or simplify the unsupported feature. Interactive elements cannot use this fallback. |
| Published; launch unavailable | Read the displayed build/launch error. Check NuGet access and the desktop graphics environment, then Publish again. The last successful run is preserved. |

Component mappings are available inside Publish when a COMPONENT is selected. They are not an extra plugin section. Unsupported features block the run; resolve the displayed diagnostic before publishing again. The first run restores/builds the pinned runtime packages, so it takes longer than reusing an unchanged publication. Package restore requires NuGet access; execution requires a graphics-capable desktop.

The registered sample remains an editable native Gum template; `samples/GumBridge.Runtime` supplies the FRB2 host compiled in disposable staging with generated visuals. The pinned runtime profile is separate from an existing game. Existing-root CLI registration remains available for future agent workflows, but this Publish-to-FRB2 path currently requires a Sample workspace. Plugin routes have no challenge/session token. CLI registration uses a protected local descriptor; plugin origins cannot call registration. Keep the development manifest allowlist at `http://localhost:48931` and preserve the ignored Figma-assigned manifest ID. The bridge binds `127.0.0.1:48931` and rejects invalid Host/Origin and nonfixed routes. Run the development host only on a trusted machine.

To repeat the real FRB2 smoke test in a graphics-capable session:

```sh
dotnet test tests/GumBridge.Contracts.Tests --filter FullyQualifiedName~PublishedScreenRunsInRealFrb2
```

This opens and closes a temporary FRB2 window. It verifies native loading, generated-code compilation, first-draw identity and unchanged target files; it does not establish real Figma visual fidelity.

## Architecture

The **TypeScript Figma plugin** handles page-screen bindings, component mappings, explicit snapshot publication and diagnostics through Connection and Publish. The **local .NET 10 bridge** owns deterministic conversion, Gum tooling, snapshot storage, and guarded file updates through separate modules. Thin CLI and MCP adapters forward to one bridge host; they do not duplicate conversion or file-writing logic.

Figma is the source of record for managed visuals. Native Gum files and generated C# reproduce those visuals. Handwritten application code owns behavior and must survive regeneration.

The standalone FRB2 test application is implemented; the sample-design creator remains planned. No existing game, production Figma design, hosted backend, or specific agent vendor is a prerequisite. Real Figma-client and macOS/Windows compatibility checks remain required before claiming those environments are supported.
