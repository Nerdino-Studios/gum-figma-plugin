# T02 Gum compatibility record (2026-09-22)

This is a **minimal native GumCli smoke test**, not a runnable sample game, Figma integration, generated-code compilation, or OS certification. `samples/GumBridge.Sample/Content/GumProject/GumProject.gumx` is an editable Gum XML project with one screen (`Screens/Preview.gusx`, a filled rectangle and Arial text). `ProjectCodeSettings.codsj` records the GumCli MonoGame code-generation target. `GumBridge.Sample.csproj` is only the destination marker used by `codegen-init`, with default C# compilation disabled; the actual standalone application and runtime package wiring belong to later tickets. The generated C# classes are not compiled in T02.

## Pinned tools and prerequisites

| Item | Pinned / observed | Status |
|---|---|---|
| Bridge SDK | .NET SDK `10.0.100`, `global.json` with roll-forward disabled | `dotnet --version` = `10.0.100` on macOS arm64 |
| GumCli | Local manifest `.config/dotnet-tools.json`: `2026.9.2.1`; `gumcli --version` reported `2026.9.2.1+7296a994cf438ff39ff80bbf0283341e55a15d3b` | Tool restored from NuGet and check/codegen/fonts/screenshot exercised on macOS |
| GumCli runtime | .NET runtime 8.0 (tool target `net8.0`); local temporary runtime `8.0.31` installed for direct invocation | `dotnet tool run` without runtime 8 failed (exit 150); the smoke script uses `DOTNET_ROLL_FORWARD=Major` and was exercised against the installed .NET 10 runtime. For normal use, install .NET 8 runtime alongside pinned .NET 10 SDK. |
| Renderer | GumCli bundled `MonoGame.Framework.DesktopGL` `3.8.4.1`, `MonoGame.Library.SDL` `2.32.2.1`, `MonoGame.Library.OpenAL` `1.24.3.2` (versions read from installed GumCli `.deps.json`) | MonoGame screenshot command ran on macOS arm64; OS needs SDL/OpenGL graphics support, usable display/graphics context and native audio dependencies; headless CI may need a display. These are dependencies of GumCli, not packages added to the sample placeholder. |
| Fonts | Project property `FontGenerator=KernSmith`; GumCli includes KernSmith and FreeType rasterizer `0.21.0`, FreeTypeSharp `3.1.0` | macOS `/System/Library/Fonts/Supplemental/Arial.ttf` present; `gumcli fonts` produced `Font24Arial.fnt` and `Font24Arial_0.png`; system font and generated FontCache are intentionally not redistributed. Arial availability/licensing is a prerequisite for this local check, not a promise of identical glyphs across machines. |

KernSmith is the explicit generator for this new project. Do not silently change older BMFont projects; their generator and font metrics may differ. The pinned CLI source implementation of `FontsCommand` chooses KernSmith for this project; this does not establish Windows BMFont compatibility. Native project sources are checked in; generated `FontCache` and generated C# are ignored because they contain environment-dependent outputs or regenerate from the native files. `ExampleSpriteFrame.png` and Standards were created by pinned `gumcli new ... --template empty`.

## Reproduce (macOS graphics session)

From the repository root, install SDK 10.0.100 and .NET runtime 8, then:

```sh
dotnet tool restore
scripts/check-native-sample.sh
```

The script copies the native Gum project and destination `.csproj` marker into disposable staging, checks native project load, generates a fresh KernSmith font atlas and C# only there, then validates an 800x600 MonoGame DesktopGL PNG there. Staging is removed on both success and failure, including partial codegen failure; no GumCli command targets the repository sample. It exits nonzero for any missing required result. `DOTNET_ROLL_FORWARD=Major` in this smoke script supports machines with only SDK/runtime 10, but .NET 8 is the tool's actual target and installing it is recommended. Preview the native file in a compatible Gum editor to edit it; graphical editor launch was **not** tested. Rendering produced the visible blue panel/white text when the temporary PNG was inspected; it is not a checked-in visual baseline. GumCli emitted a nonfatal GL texture-unit diagnostic during rendering (`GLD_TEXTURE_INDEX_2D ... unloadable`); investigate on other graphics drivers before asserting portability.

## Executed red -> green and validation

- Red, tool layer: `dotnet tool run gumcli -- --version` with no local manifest failed exit 1: `Cannot find a tool in the manifest file ... gumcli`. After installing the pinned local tool, running it without .NET 8 failed exit 150 with `Microsoft.NETCore.App 8.0.0` missing. This identified both missing capabilities before green.
- Red, native load check: first screen with `<Instances>` wrapper failed `gumcli check` exit 1: `Instances must be <Instance> directly under the root`; the direct-instance Gum XML passed after fixing it.
- Green: `scripts/check-native-sample.sh` exit 0: `No errors found`, fresh generation of Arial 18 and 24 in staging, `Generated code for 1 element(s)` in staging, `Native Gum 800x600 PNG verified`. A focused architecture regression simulates GumCli writing partial generated C# then failing; it verifies the destination was in staging, no checkout output changed, and staging was removed. Codegen reported `Syntax version auto-detection: No Gum PackageReference or ProjectReference found ... Falling back to version 0`; generated code compiles **not verified**, since no runtime app/packages are wired yet.
- `dotnet build GumBridge.sln` exit 0, 0 warnings/errors (T01 bridge skeleton only; sample placeholder is not in this solution). `python3 -m unittest discover -s tests/architecture -v` exit 0, two tests. These checks do not imply runtime sample compilation.

## Coverage remaining

| Environment / capability | Status |
|---|---|
| macOS arm64 26.0 GumCli load, fonts, codegen, MonoGame DesktopGL screenshot | Executed here (PNG manually inspected); generated code compilation and editor GUI unrun |
| Windows GumCli/font generation/native DLLs/MonoGame DesktopGL screenshot | **Unrun**; requires .NET 10 SDK, .NET 8 runtime, Arial or configured licensed font, working OpenGL/SDL environment; run the same smoke script in a Windows-compatible shell, inspect PNG and record results before claiming support |
| Figma Design desktop on macOS, GAM-208 shell | Owner observed a blank document displaying Selection, Mappings, Preview and changes, and Connection after importing a manually copied `manifest.json`; the original template filename was rejected (`Manifest must be named 'manifest.json'`). Client version was not recorded. Fresh import of a build-generated manifest, loopback communication and interactive sample runtime remain unrun/not implemented. |

Upstream reference inspected: local Gum source documentation and `Tools/Gum.Cli/Commands/FontsCommand.cs` for supported commands and generator behavior. The source tree inspected was at `406fdff693ef2d7d1705d542c437837df38ba8f8`; executable compatibility was established against the pinned NuGet tool above, **not** by assuming that source checkout or the spec's `554ca3a8b1779b38b0c81f98848bd55cf48a69fe` commit has identical behavior.
