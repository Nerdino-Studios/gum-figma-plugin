# Gum Figma Plugin

A visual Figma plugin and local C#/.NET 10 bridge for turning Figma designs into native Gum UI. External coding agents use MCP or a CLI to request deterministic conversion and connect the generated UI to application behavior.

**Status: GAM-240 development plugin automatic local-only bridge connection, workspace selection, immutable publication and staged native preview (mock/host checks only).** The pinned GumCli loads, generates code/fonts, and renders the editable one-screen Gum project on tested macOS arm64; the sample application is not runnable and generated C# has not been compiled as an application. GAM-218 bundles a versioned offline catalog of the verified native frame/text/image slice and stores small, namespace-scoped source-ID/public-alias mappings in plugin data. The mapping panel marks Button/TextBox/ScrollViewer adapters pending; custom target catalogs, reference mappings, and target-specific validation are not yet available. Sample-design creation remains unavailable. GAM-216 adds exact licensed bitmap-font mappings for staged preview and scoped decorative PNG approval (unit-checked, not real-client verified). The bridge uses loopback fixed routes; plugin routes have no credentials, while CLI-only registration uses a protected local descriptor and sole-host lock. A registered Sample workspace is not created automatically: initialize it explicitly with the CLI. The owner-observed authenticated Figma Design desktop 126.9.10 macOS result is historical GAM-210 evidence, not validation of GAM-240 automatic connection, publication or visible preview. GAM-218 mapping persistence/UI in a real Figma client and Windows desktop checks remain **UNRUN**. See [compatibility](docs/compatibility.md).

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

`dotnet test GumBridge.sln` runs the wire and pairing-host integration tests; the architecture gate is the Python unittest command above. The pinned TypeScript and official Figma typings are only compilation dependencies, not evidence of a real Figma client test. For the T02 native Gum smoke check, install .NET runtime 8 and run `dotnet tool restore` followed by `scripts/check-native-sample.sh` in a graphics-capable session. See [compatibility](docs/compatibility.md) for verified macOS results and unrun Windows checks.

## Development plugin shell (GAM-208)

**One-time developer registration (not an end-user install step):** In Figma Design desktop, create a **New Plugin** from the Development plugins menu and save its Figma-generated `manifest.json` outside this repo. From the repository root run:

```sh
npm ci --prefix apps/figma-plugin
npm run setup:manifest --prefix apps/figma-plugin -- /absolute/path/to/figma-generated/manifest.json
npm run build --prefix apps/figma-plugin
```

Then choose **Plugins → Development → Import plugin from manifest…** and select this repository's `apps/figma-plugin/manifest.json`; rerun that development plugin after rebuilding. The setup command imports only the legitimate Figma-assigned ID, never its entry paths or network permissions. It refuses missing/invalid IDs and conflicting existing IDs; repeated setup with the same ID leaves the local manifest untouched. This ignored local ID must remain stable for document plugin metadata. The portable checked-in `manifest.template.json` has no ID; building without registration produces an ID-free manifest but cannot enable plugin-data persistence. If you launch without an ID, the panel shows setup instructions instead of crashing. Do not publish or distribute an ID-free manifest. End users do **not** run this developer registration command; distributing/installing a finished plugin is a separate release workflow not yet implemented or tested.

Run `npm run typecheck --prefix apps/figma-plugin` and `npm test --prefix apps/figma-plugin` to validate local changes. A rebuild preserves a current ignored local manifest byte-for-byte, including its Figma-assigned ID; it upgrades only the previously known stale loopback permission. Never commit `manifest.json` or credentials. The owner imported a manually copied `manifest.json` for the original shell check and observed Selection, Mappings, Preview and changes, and Connection in a blank document (client version not recorded). Later, Figma Design desktop 126.9.10 on macOS imported the corrected localhost development manifest and ran the rebuilt plugin.

For local development, run `dotnet run --project src/GumBridge.Host -- serve`; opening or reloading the plugin now checks the fixed loopback bridge automatically. If offline, start the host and click **Reconnect to local bridge**; no challenge or session token is needed. Select a registered workspace explicitly in Connection. To create the native-only Sample workspace run `dotnet run --project src/GumBridge.Host -- sample init --directory /absolute/new/sample` while the host runs. To register a trusted existing root run `dotnet run --project src/GumBridge.Host -- workspace register --directory /absolute/existing/root --project path/inside/root/app.csproj --gumx path/inside/root/UI.gumx`. CLI registration alone uses a protected per-user descriptor; plugin origins cannot call local registration. Keep the development manifest allowlist at `http://localhost:48931`; preserve any ignored local Figma-assigned manifest ID. The bridge binds `127.0.0.1:48931` and rejects invalid Host/Origin or nonfixed routes. Local processes can call plugin routes without credentials; do not run this development host on an untrusted machine. Previous Figma Design desktop 126.9.10 macOS pairing evidence is historical, not proof of the new automatic connection or selected-frame publication/preview. New real-client checks and Windows checks are **UNRUN**. Publication and staged preview do not apply to target files.

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
