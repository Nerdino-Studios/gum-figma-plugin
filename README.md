# Gum Figma Plugin

A visual Figma plugin and local C#/.NET 10 bridge for turning Figma designs into native Gum UI. External coding agents use MCP or a CLI to request deterministic conversion and connect the generated UI to application behavior.

**Status: T01 skeleton + T02 minimal native Gum smoke sample + GAM-208 shell + GAM-206 wire contracts + GAM-210 macOS development-plugin pairing slice + GAM-214 local sample initialization/registration + GAM-215 bounded selection capture + GAM-212 staged publication.** The pinned GumCli can load, generate code/fonts and render the editable one-screen Gum project on the tested macOS arm64 host. The sample application is not runnable and generated C# has not been compiled. The plugin builds a scene entry and offline/empty iframe panel; mapping/catalog, sample creation and preview are not implemented; one supported selected frame can be captured and published to the first paired workspace with an explicit public alias. The bridge has a loopback pairing host, explicit local native sample initialization and existing-root registration, and a credential-guarded safe workspace list; conversion is not implemented; published snapshots and blobs are stored under host local user data without touching workspace target files. The owner observed a successful authenticated request from Figma Design desktop 126.9.10 on macOS 26.6.2 (25G83) after importing the corrected localhost manifest and rebuilding the plugin. Windows desktop pairing remains **UNRUN** under GAM-237; spec A19 cross-platform acceptance remains incomplete. See [the compatibility record](docs/compatibility.md) for evidence and limits.

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

For local pairing, run `dotnet run --project src/GumBridge.Host -- serve` in a local terminal, press Enter there to issue a two-minute one-use challenge, then open the plugin Connection tab and enter the challenge. The authenticated request lists registered workspaces; it does not create a Sample workspace. Run `dotnet run --project src/GumBridge.Host -- sample init --directory /absolute/new/sample` separately while the host is running. Choose a new writable path whose parent exists; existing destinations are refused, including nonempty directories. A second host will refuse the per-user lock. To register an existing trusted local root, run `dotnet run --project src/GumBridge.Host -- workspace register --directory /absolute/existing/root --project path/inside/root/app.csproj --gumx path/inside/root/UI.gumx`. Both relative file paths must exist inside the chosen root; no nearest-project inference occurs. This does not register build/render commands or allow generated writes yet. The CLI returns 0 success, 1 conflict/invalid path, 2 syntax, or 3 unavailable host. CLI and host use a protected per-user local descriptor and registry under the OS LocalApplicationData `GumBridge` directory; neither the descriptor nor absolute paths enter the Figma document or Git repository. Stop the host to discard sessions. Use the precise development manifest network allowlist at `http://localhost:48931` (the host still binds only `127.0.0.1:48931` and accepts only matching loopback Host/port). Figma Design desktop 126.9.10 on macOS rejected `http://127.0.0.1:48931` in `devAllowedDomains` with `Invalid value for devallowsdomains. http://127.0.0.1:48931 must be a valid url`. A build upgrades only that known stale permission in an existing ignored local manifest while preserving its Figma-assigned ID; unexpected custom network permissions fail with an instruction rather than being overwritten. Check the actual `manifest.json` before importing. In the prior real macOS desktop plugin, the owner entered a fresh locally authorized challenge and saw `Paired; 0 registered workspaces (registration is not available yet).` That older observation predates GAM-214; the updated list UI has not been retested in a real client. This requires a successful pair response and authenticated `/v1/workspaces` response; zero is expected before GAM-214. No local-network permission prompt appeared. An independent curl without credentials returned 401 and synthetic `Origin: null` preflights returned 204; real Figma preflight packets were **not captured**, so no packet-level preflight result is claimed. Windows desktop acceptance is **UNRUN** under GAM-237, and spec A19 remains incomplete. A blank document opens the four panel views without a game workspace or bridge. Selection names are read-only; the Preview and changes tab permits a supported single-frame capture and publication after pairing and entering a public alias. The document namespace is retained in Figma root plugin metadata; on each launch explicitly choose New design namespace or Continue known design before capture (copies may inherit metadata). No mapping catalog/editor, sample creator, conversion or preview exists. An unsupported or incomplete capture remains unpublished. The built-in catalog and real offline mapping workflow belong to later tickets (GAM-218), not this shell.

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
