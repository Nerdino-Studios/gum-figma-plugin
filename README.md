# Gum Figma Plugin

A visual Figma plugin and local C#/.NET 10 bridge for turning Figma designs into native Gum UI. External coding agents use MCP or a CLI to request deterministic conversion and connect the generated UI to application behavior.

**Status: T01 skeleton + T02 minimal native Gum smoke sample + GAM-208 shell + GAM-206 wire contracts + GAM-210 macOS development-plugin pairing slice.** The pinned GumCli can load, generate code/fonts and render the editable one-screen Gum project on the tested macOS arm64 host. The sample application is not runnable and generated C# has not been compiled. The plugin builds a scene entry and offline/empty iframe panel; mapping/catalog, sample creation, preview and publication are not implemented. The bridge has a minimal executable loopback pairing host and a credential-guarded empty-workspace request; conversion and registration are not implemented. The owner observed a successful authenticated request from Figma Design desktop 126.9.10 on macOS 26.6.2 (25G83) after importing the corrected localhost manifest and rebuilding the plugin. Windows desktop pairing remains **UNRUN** under GAM-237; spec A19 cross-platform acceptance remains incomplete. See [the compatibility record](docs/compatibility.md) for evidence and limits.

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

Run `npm ci --prefix apps/figma-plugin`, `npm run typecheck --prefix apps/figma-plugin`, `npm run test --prefix apps/figma-plugin`, and `npm run build --prefix apps/figma-plugin`. In Figma Design desktop, use **Plugins → Development → Import plugin from manifest…** and choose the generated `apps/figma-plugin/manifest.json` (which points to the generated `dist/` files). The checked-in `manifest.template.json` is the portable, ID-free source; build copies it to the exact filename Figma requires only when local `manifest.json` is absent. Figma may assign an ID during development import: keep your local manifest with that ID for future builds, which will not overwrite it. `manifest.json` is Git-ignored; do not check an ID or credentials into the shared template. Rebuild after edits and rerun the development plugin. The owner imported a manually copied `manifest.json` for the original shell check and observed Selection, Mappings, Preview and changes, and Connection in a blank document (client version not recorded). Later, Figma Design desktop 126.9.10 on macOS imported the corrected localhost development manifest and ran the rebuilt plugin.

For local pairing, run `dotnet run --project src/GumBridge.Host -- serve` in a local terminal, press Enter there to issue a two-minute one-use challenge, then open the plugin Connection tab and enter the challenge. The authenticated request returns an empty registered-workspace list; it does not create a Sample workspace. Stop the host to discard sessions. Use the precise development manifest network allowlist at `http://localhost:48931` (the host still binds only `127.0.0.1:48931` and accepts only matching loopback Host/port). Figma Design desktop 126.9.10 on macOS rejected `http://127.0.0.1:48931` in `devAllowedDomains` with `Invalid value for devallowsdomains. http://127.0.0.1:48931 must be a valid url`. A build upgrades only that known stale permission in an existing ignored local manifest while preserving its Figma-assigned ID; unexpected custom network permissions fail with an instruction rather than being overwritten. Check the actual `manifest.json` before importing. In the real macOS desktop plugin, the owner entered a fresh locally authorized challenge and saw `Paired; 0 registered workspaces (registration is not available yet).` This requires a successful pair response and authenticated `/v1/workspaces` response; zero is expected before GAM-214. No local-network permission prompt appeared. An independent curl without credentials returned 401 and synthetic `Origin: null` preflights returned 204; real Figma preflight packets were **not captured**, so no packet-level preflight result is claimed. Windows desktop acceptance is **UNRUN** under GAM-237, and spec A19 remains incomplete. A blank document opens the four panel views without a game workspace or bridge. Selection names are read-only; mapping catalog/editor, sample creator, export, publication and previews are explicitly unavailable, not simulated successes. The built-in catalog and real offline mapping workflow belong to later tickets (GAM-218), not this shell.

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
