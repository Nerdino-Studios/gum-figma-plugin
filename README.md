# Gum Figma Plugin

A visual Figma plugin and local C#/.NET 10 bridge for turning Figma designs into native Gum UI. External coding agents use MCP or a CLI to request deterministic conversion and connect the generated UI to application behavior.

**Status: T01 skeleton + T02 minimal native Gum smoke sample + GAM-208 development plugin shell.** The pinned GumCli can load, generate code/fonts and render the editable one-screen Gum project on the tested macOS arm64 host. The sample application is not runnable and generated C# has not been compiled. The plugin now builds a scene entry and offline/empty iframe panel, but mapping/catalog, sample creation, preview, publication and bridge pairing are not implemented. The bridge has no executable host or conversion behavior. In an owner-run macOS Figma Design desktop check, a manually copied `manifest.json` imported and the blank document displayed all four offline views without a bridge or workspace. The build-generated manifest has not been separately imported in desktop. Windows and plugin/bridge communication checks remain unrun. See [the compatibility record](docs/compatibility.md) for versions, commands and limits.

## Start here

Read the [approved implementation specification, v0.2](docs/figma-gum-plugin-spec.md).

- **Section 5:** module responsibilities and dependency boundaries.
- **Section 13:** red -> green -> refactor, test layers, and acceptance cases A01-A20.
- **Section 14:** ordered implementation tasks T01-T29.
- **Section 16.2:** copyable implementation-agent handoff prompt.

Repository guidance for coding agents is in [AGENTS.md](AGENTS.md). The specification is authoritative; this README is only an entry point.

## T01 checks

Install the .NET SDK pinned in `global.json` (10.0.100), Node.js and npm, and Python 3. Run from the repository root:

```sh
dotnet build GumBridge.sln
python3 -m unittest discover -s tests/architecture -v
npm ci --prefix apps/figma-plugin
npm run typecheck --prefix apps/figma-plugin
```

`dotnet test GumBridge.sln` currently discovers **no .NET test projects**; the executable architecture gate is the Python unittest command above. The pinned TypeScript and official Figma typings are only compilation dependencies, not evidence of a real Figma client test. For the T02 native Gum smoke check, install .NET runtime 8 and run `dotnet tool restore` followed by `scripts/check-native-sample.sh` in a graphics-capable session. See [compatibility](docs/compatibility.md) for verified macOS results and unrun Windows checks.

## Development plugin shell (GAM-208)

Run `npm ci --prefix apps/figma-plugin`, `npm run typecheck --prefix apps/figma-plugin`, `npm run test --prefix apps/figma-plugin`, and `npm run build --prefix apps/figma-plugin`. In Figma Design desktop, use **Plugins → Development → Import plugin from manifest…** and choose the generated `apps/figma-plugin/manifest.json` (which points to the generated `dist/` files). The checked-in `manifest.template.json` is the portable, ID-free source; build copies it to the exact filename Figma requires only when local `manifest.json` is absent. Figma may assign an ID during development import: keep your local manifest with that ID for future builds, which will not overwrite it. `manifest.json` is Git-ignored; do not check an ID or credentials into the shared template. Rebuild after edits and rerun the development plugin. The owner imported a manually copied `manifest.json` in Figma Design desktop and observed Selection, Mappings, Preview and changes, and Connection in a blank document. The desktop client version was not recorded; a fresh import of a build-generated manifest has not been observed.

A blank document opens the four panel views without a game workspace or bridge. Selection names are read-only; mapping catalog/editor, sample creator, export, publication, previews and pairing are explicitly unavailable, not simulated successes. The built-in catalog and real offline mapping workflow belong to later tickets (GAM-218), not this shell.

## Architecture

The **TypeScript Figma plugin** handles selection, control/state mappings, explicit snapshot publication, diagnostics, and previews. The **local .NET 10 bridge** owns deterministic conversion, Gum tooling, snapshot storage, and guarded file updates through separate modules. Thin CLI and MCP adapters forward to one bridge host; they do not duplicate conversion or file-writing logic.

Figma is the source of record for managed visuals. Native Gum files and generated C# reproduce those visuals. Handwritten application code owns behavior and must survive regeneration.

## Implementation milestones

| Through task | Outcome |
|---|---|
| T10 | Selected Figma frame -> native Gum -> preview. |
| T19 | Standalone sample design and initial control coverage. |
| T23 | Regeneration preserves a handwritten handler that fires exactly once. |
| T29 | Packaged standalone v1 with documented compatibility and acceptance results. |

The implementation supplies its own sample-design creator and Gum test application. No existing game, production Figma design, hosted backend, or specific agent vendor is a prerequisite. Real Figma-client and macOS/Windows compatibility checks remain required before claiming those environments are supported.
