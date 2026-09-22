# Figma-to-Gum Bridge: Implementation Specification

Version: 0.2  
Date: 2026-09-21  
Status: Approved architecture; implementation contract. The plugin, bridge, fixtures, and compatibility tests described here have not been implemented or executed as part of preparing this document.

Supersedes v0.1. This version removes production-game and pre-existing Figma-design prerequisites, makes standalone onboarding explicit, defines internal ownership boundaries, and requires red-then-green development. Requirements use MUST for mandatory behavior and SHOULD for defaults that may change with a documented reason. Names of new classes, commands, and endpoints are proposed product interfaces, not existing Gum or Figma APIs.

## 1. Product contract

Build two deliverables: a visual Figma plugin and a local C#/.NET 10 bridge. An external coding agent uses MCP or a CLI to pull a published design, request deterministic conversion, and connect the resulting UI to application behavior.

**Figma is the source of record for managed visual design. Native Gum files and generated C# reproduce that design. Handwritten application code owns behavior and runtime data.**

The primary workflow is:

```text
Figma document + mapping metadata
              |
   Figma plugin: select / map / publish
              |
     immutable design snapshot
              | authenticated loopback HTTP
              v
        Local bridge host <---- CLI or MCP stdio adapter <---- External agent
              |
      deterministic conversion
              |
     native Gum files in staging
              |
       Gum validation / codegen / render
              |
      ownership-checked file updates
              v
   Bundled sample application, or a registered project
              |
      preview + diagnostics + verification receipt
              v
        Figma plugin
```

The CLI and MCP adapter are modes of the same bridge distribution, not additional hosted services. One bridge host owns persistent operations and all managed writes.

The conversion engine MUST work without an AI model. Identical supported inputs and pinned tooling MUST produce the same managed output. The agent invokes the pipeline, explains blockers, and implements handwritten integration; it does not reconstruct the UI from screenshots or independently guess conversion rules.

No existing game repository, production Figma frame, particular agent vendor, cloud service, or separate database server is required to begin implementation. The implementation team supplies a sample-design creator and a bundled Gum application. A normal Figma development environment and local development tools are still required for real plugin testing.

## 2. Approved decisions, scope, and defaults

### 2.1 Approved architecture

| Area | Contract |
|---|---|
| Authoring | Normal Figma designs; a plugin panel handles mapping, publication, diagnostics, and preview. No replacement layout editor. |
| Plugin | TypeScript, with separate document-access and UI modules. |
| Bridge | C#/.NET 10; one local application with separate conversion, Gum-tooling, storage, and file-management modules. |
| Agent | External agent connects using thin MCP or CLI adapters. No model embedded in the plugin or converter. |
| Output | Native editable Gum screens/components, assets, generated C#, and typed or machine-readable integration contracts. |
| Ownership | Figma -> Gum only. No reverse synchronization. Handwritten behavior and unrelated Gum elements are protected. |
| Reuse | Map Figma components to generated reusable components or existing Gum controls through explicit contracts. |
| Initial behavior | Functional controls, visual states, and named event/data connection points. Application logic stays outside conversion. |
| Fidelity | Preserve layout intent and editable interactive elements; diagnose unsupported features; require approval for decorative rasterization. |
| Standalone delivery | Include a sample Figma-design creator and a small Gum test application. Production-game integration is not a v1 release prerequisite. |

### 2.2 Implementation defaults

Use Figma Design desktop on macOS and Windows for the initial compatibility matrix. Development installation is in scope; public marketplace distribution, browser certification, and Linux packaging are deferred.

Use TypeScript with strict checking and a small component-based plugin UI. The UI framework is replaceable and must not own conversion rules. Use a pinned .NET 10 SDK for bridge code and a pinned compatible Gum toolchain. Start the standalone renderer with MonoGame DesktopGL; keep FlatRedBall2 and other application-host conventions outside the conversion core. This is an implementation target, not a claim that compatibility has already been tested.

Use authenticated loopback HTTP between plugin and bridge. Use MCP stdio between an agent and the bridge's MCP adapter. The adapter forwards to the running bridge host. The CLI uses the same host API. Do not add a second writer, independent background service, cloud relay, Figma REST-token requirement, or official-Figma-MCP dependency.

Use local versioned JSON metadata and content-addressed asset files for v1 storage. The host is the sole writer. Persist operation status and recovery journals; no database server or event-sourcing framework is required. Keep storage behind narrow interfaces.

Pin the Figma API typings, SDKs, package versions, and native rendering dependencies in lock/configuration files. Do not use an unpinned Gum development branch as an implicit release dependency.

### 2.3 Definition of standalone

The plugin MUST open in a blank Figma document without a bridge connection or a registered game. It MUST offer a built-in control catalog, mapping UI, and an explicit **Create sample design** action.

The bridge MUST offer a **Sample workspace** backed by the bundled Gum application, created in an explicit user-writable directory. This is the initial generation target. Connecting a real game is an optional later registration flow.

Conversion, runtime compatibility analysis, and Gum previews require the local bridge. Offline UI must say that those results are unavailable or stale; it must not fabricate a successful preview or hide the missing dependency.

## 3. Upstream constraints and compatibility gate

The earlier repository review used Gum commit `554ca3a8b1779b38b0c81f98848bd55cf48a69fe`, dated September 21, 2026. This specification retains that source baseline; it does not assert that a particular released package contains every feature. Code-generation, screenshot, and font documentation at that commit were rechecked for this revision. [G9]

GumCli supplies validation, C# generation, and screenshot rendering. Code generation can produce some elements before returning failure for others. Always run it in isolated staging and treat a nonzero required result as failure for the entire plan. [G1][G2]

The documented screenshot command accepts dimensions and backend selection, but does not expose an interaction-state selector. Use the bundled runtime harness for stateful previews and interaction verification; do not invent a `gumcli screenshot --state` option. [G3]

The reviewed font documentation distinguishes cross-platform KernSmith from Windows-only BMFont. Inspect and pin the chosen font configuration. Do not silently change an existing project's font generator or claim that every existing project can bake fonts on macOS. [G4]

Gum includes HTML-import tooling worth inspecting for prior conversion/fidelity approaches. Direct structured Figma extraction remains canonical: no intermediate CSS/HTML round trip. [G6]

Figma separates scene access from a custom iframe UI, with message passing between them. Its network guide also documents a plugin Fetch API; iframe networking is an implementation choice, not a claim that no other networking API exists. Use one tested BridgeClient implementation and keep network transport out of document extraction. [F1][F2]

Before feature expansion, implementation MUST prove: development-plugin installation, authenticated loopback communication, native Gum loading, code generation, fonts, and a rendered sample on each supported OS. Record exact versions, native dependencies, and any limitation in `docs/compatibility.md`. An unavailable package feature requires an explicit source-build pin or a documented upstream blocker, not an undocumented workaround.

## 4. User workflow and plugin UI

### 4.1 First launch: no project and no bridge

Show **Selection**, **Mappings**, **Preview and changes**, and **Connection** views. An empty document shows a useful empty state: select a frame, create a design normally, or choose **Create sample design**. Do not open with a mandatory game-repository wizard.

Bundle a versioned built-in control-catalog artifact generated from the tested bridge adapters. Offline mapping uses that artifact; it is data, not a second TypeScript implementation of Gum conversion. Unknown project-specific mappings remain visible but unresolved until their catalog is available.

The plugin may check field types, aliases, missing selection, and available Figma properties offline. Target-specific compatibility checks execute in the bridge. Revalidate catalog-dependent mappings after connecting or changing the target profile.

### 4.2 Create the standalone sample

**Create sample design** requires an explicit click. It creates a separate sample page containing a menu, reusable controls, and reference frames using the Figma API. It must never overwrite existing layers, run automatically, or require a paid shared library. Repeating the action creates a new isolated sample or asks before replacing only its own prior sample.

The sample-design creator is test/onboarding functionality, not a second UI authoring system. Its sources and small assets are bundled with the project. Font setup is documented and missing fonts produce an actionable message.

### 4.3 Pair with the bridge

Start the local bridge, create or choose its Sample workspace, and pair through a one-time local consent flow. The plugin displays connection state, target label, capability/catalog version, and toolchain readiness.

The default choice is Sample workspace. A later developer flow can register an existing local root, `.csproj`, `.gumx`, generated-output locations, font configuration, and trusted build/render profile. Paths are selected locally; Figma metadata cannot authorize arbitrary directories. Designers see labels and catalogs, not unrestricted filesystem access.

### 4.4 Select and map

Select a frame, component, or component set supported by the exporter. Show export kind, stable public alias, dependencies, and current mapping readiness. A frame exported as a Screen must be an explicit export root; nested frames stay layout containers. A selected component or component set produces a reusable component with mapped states.

Use searchable dropdowns for existing controls, properties, states, slots, fonts, and available targets. Allow plain-text entry only where a new name is appropriate, such as a public alias or application connection-point key; validate it immediately. Designers must not need to remember C# type names or Gum property names.

Component mapping must distinguish **Generate component** from **Reference existing component**. State mapping must show which Figma variant maps to each required control state and where an explicit fallback has been approved.

### 4.5 Analyze and publish

Analyze the selected subtree and its necessary dependencies. Each diagnostic identifies the source node/property, severity, and remediation. Clicking a source diagnostic selects the relevant Figma node when available.

**Publish for agent** transfers a complete immutable snapshot to the bridge. It does not apply changes to a destination project. A structurally safe snapshot with unsupported-feature diagnostics may be published as **Blocked** for agent inspection; unsafe, inconsistent, corrupt, or incomplete captures must not be finalized.

Show the snapshot ID, captured design fingerprint, selected target, and a copyable agent instruction. Changes after publication set **Source changed** and require republication. Do not silently substitute a newer design under an existing ID.

### 4.6 Agent implementation and review

The user asks an external agent to use a published snapshot. The agent requests a plan, reads diagnostics and previews, applies authorized managed changes, and implements application behavior in separate files. No embedded chat window or model API key is required.

The plugin displays the Figma reference and Gum result side by side, with optional overlay/difference, viewport/state selector, and change list. Images are previews, not an embedded interactive game runtime. Interactive verification runs in the sample application.

Read-only previews and conversion plans work without any AI client. The external agent is an integration consumer, not a technical dependency of the converter.

### 4.7 State and failure UX

Distinguish **Offline**, **Unpublished**, **Published**, **Source changed**, **Blocked**, **Planning**, **Plan ready**, **Applying**, **Applied - unverified**, **Verified**, **Failed**, and **Recovery required**. Always associate results with their snapshot, target profile, and output hashes.

An old successful preview can remain visible only with its original identity and a clear stale label. A disconnected bridge must not erase mapping edits. An empty selection must not erase the previous published snapshot. A conversion error must leave the last successfully applied UI intact.

## 5. Modules, class responsibilities, and dependencies

### 5.1 Product and process boundaries

There are two installable products, not a fleet of services:

| Product | Runtime pieces |
|---|---|
| Figma plugin | TypeScript scene/document adapter and iframe UI communicating through typed messages. |
| Local bridge | One `gumbridge` distribution. `serve` hosts operations/storage; CLI commands and `mcp` mode forward to that host. |

The external agent is not shipped as part of either product. Multiple clients may read concurrently, but one host and one per-workspace mutation lock own all writes. Host shutdown must leave operations recoverable; MCP-client exit must not create a competing host or discard the host's completed operations.

### 5.2 Plugin modules

| Module / proposed class | Responsibility | Prohibited responsibilities |
|---|---|---|
| `SelectionReader` | Resolve supported selected roots and source identities. | Conversion rules or repository access. |
| `FigmaSnapshotExtractor` | Capture typed design data, dependencies, variable values, assets, and references with consistency guards. | Gum serialization or networking policy. |
| `MappingMetadataStore` | Read/write small plugin-owned mappings and stable aliases. | Credentials, asset storage, or runtime behavior code. |
| `PluginMessageRouter` | Validate messages between scene context and UI; correlate requests. | Acting as a catch-all domain service. |
| `BridgeClient` | Authenticated protocol calls, transfer retries, and result retrieval. | Figma layout interpretation or direct file writes. |
| UI view models/components | Present selection, mapping, connection, and review state. | Duplicating converter rules or embedding an agent. |
| `SampleDesignBuilder` | Explicitly create onboarding/test designs on a separate page. | Modifying ordinary user designs automatically. |

Use the official Figma typings behind the scene adapter. Unit tests use a narrow fake of the needed API surface; real-client smoke tests validate assumptions that fakes cannot prove.

### 5.3 Bridge modules

| Module | Representative classes / ports | Owns |
|---|---|---|
| Contracts | `DesignSnapshot`, `ControlCatalog`, `Diagnostic`, `SyncPlan`, `OperationReceipt` | Versioned immutable data contracts, wire schemas, shared enums. |
| Conversion | `SnapshotValidator`, `ComponentResolver`, `LayoutLowerer`, `StateMapper`, `GumModelBuilder` | Pure transformations from captured design and resolved target metadata to an in-memory Gum-oriented model and diagnostics. |
| Application | `PublishSnapshotHandler`, `AnalyzeSnapshotHandler`, `PlanSyncHandler`, `ApplySyncHandler`, `VerifyUiHandler` | Orchestrating one use case at a time through ports. No mapping or filesystem implementation. |
| Storage | `ISnapshotStore`, `IArtifactStore`, `IOperationStore`; filesystem implementations | Content-addressed blobs, immutable snapshots, bounded caches, operation records. |
| Gum tooling | `IGumToolchain`, `GumModelSerializer`, `GumCliRunner`, `ControlCatalogProvider`, `SampleRuntimeAdapter` | Native Gum serialization, pinned tool invocation, adapter contracts, target compile/render/test. |
| Managed files | `IManagedFileWriter`, `OwnershipPlanner`, `WorkspaceLock`, `RecoveryJournal` | Ownership checks, diffs, staged updates, stale-plan rejection, safe deletion and recovery. |
| Host and transport | HTTP route handlers, CLI handlers, MCP tools, `LocalBridgeClient` | Authentication, transport validation, command parsing, dependency composition; delegate operations to Application. |

Create interfaces at side-effect or target boundaries, not an interface for every trivial class. Keep implementation-specific rules private where possible. An operation handler may coordinate modules but MUST NOT grow into a class that extracts Figma, converts layout, runs tools, and writes files itself.

### 5.4 Dependency rules

Contracts have no framework dependency. Conversion depends on Contracts and pure internal model code only. Application depends on Contracts, Conversion, and ports. Infrastructure implements those ports and may depend on Gum libraries, processes, and the filesystem. The host composes these modules.

Only the Gum tooling adapter references Gum model/runtime packages. Only the sample runtime references its rendering/application host. The conversion core MUST NOT reference Figma runtime objects, ASP.NET, MCP SDK types, FlatRedBall2, rendering libraries, `System.IO` operations, process launching, or model/network clients.

The managed-file writer must accept an already validated plan; it must not invoke conversion or decide application behavior. GumCli executes against staging, not arbitrary repository paths. Architecture tests enforce project-reference direction and the prohibition on side effects in the core.

### 5.5 Suggested repository organization

```text
apps/figma-plugin/
  manifest.template.json
  src/document/                 # Figma access and typed extraction
  src/ui/                       # Selection, mappings, review, connection
  src/transport/                # Typed messages and BridgeClient
  src/sample/                   # Explicit sample-design creator
src/
  GumBridge.Contracts/
  GumBridge.Conversion/
  GumBridge.Application/
  GumBridge.Infrastructure/     # Separate Storage/, Gum/, ManagedFiles/ modules
  GumBridge.Host/               # serve, CLI, and MCP entry modes
schemas/                        # Wire schemas and cross-language fixtures
samples/GumBridge.Sample/        # Small Gum + MonoGame app; no game dependency
fixtures/                       # Captured designs, assets, expected output
catalogs/                       # Generated built-in control catalog
scripts/                        # Reproducible bootstrap/build/test entrypoints
tests/                          # Contract, conversion, transport, ownership, runtime
docs/                          # Spec, compatibility, setup, agent guide
```

Keep module boundaries even where several modules share one infrastructure project. Do not create separately deployed services or a general-purpose conversion platform to enforce these boundaries.

## 6. Snapshot, mapping, and identity contracts

### 6.1 Canonical design versus execution target

A snapshot represents a captured Figma design, not a machine or game directory. Workspace selection belongs to the conversion request. It must be possible to inspect the same snapshot or plan it against another compatible registered workspace without editing its source design.

Use checked-in, versioned wire schemas and valid/invalid cross-language test vectors. Reject unsupported major versions. Do not silently ignore an unknown field that changes layout semantics; optional informational extensions must be explicitly distinguished from semantic fields.

| Contract | Required information |
|---|---|
| `DesignSnapshot` | Schema version, content-derived snapshot ID, document namespace, selected root IDs, design nodes, components/dependencies, resolved variables, mappings, reference cases, asset hashes, extraction diagnostics. |
| `SnapshotObservation` | Capture time, plugin build, optional source link/file key, capture-session status. Metadata is outside canonical content hashes. |
| `MappingDocument` | Source identity, stable public alias, generated/referenced mode, control role/catalog ID, property/slot/state bindings, connection points, fallback approvals, catalog version. |
| `WorkspaceProfile` | Local workspace ID/root, explicit project paths, renderer/tool versions, target capabilities, resolved existing-component hashes, font mappings, trusted commands, output ownership scope. Not stored in Figma. |
| `ControlCatalog` | Stable control/profile IDs, revision/hash, supported properties, types, slots, required children/states, event/data contracts, capability constraints. |
| `SyncPlan` | Immutable plan ID/hash, snapshot/workspace/profile IDs, baseline hashes, proposed managed files and reference edits, contract diff, diagnostics, required approvals, preview/validation artifact IDs. |
| `OperationReceipt` | Status, operation IDs, exact inputs and outputs checked, write outcome, verification results, recovery/rollback availability, artifact IDs. |

Source node data includes hierarchy and paint order, transforms, visibility, sizing modes, padding, spacing, alignment, clipping, bounds, text, images, components, and supported styles. Keep design intent and measured bounds; do not throw away constraints and retain only absolute positions.

Capture only selected roots and the transitive definitions/assets needed to reproduce them. Do not scan/export the whole file by default. Preserve component library keys where available and local instance IDs. A missing definition must resolve through an explicit registered-component mapping or produce a blocker.

Resolve the selected Figma variable mode into concrete values while retaining its provenance. Capturing variables does not promise runtime themes. The bridge never accepts executable expressions inside mappings or connection-point metadata.

### 6.2 Identity and aliases

Use document namespace plus Figma node ID for source identity. A document namespace is created/associated through the plugin and retained in small plugin metadata. It is not a path or an access credential.

Keep public export aliases and binding keys separate from Figma layer display names. Renaming a layer MUST NOT automatically rename a generated public member. Duplicate aliases, case-insensitive filename collisions, invalid identifiers, and ambiguous copied metadata block planning until explicitly resolved.

Do not require `figma.fileKey`: Figma restricts it to private plugins with the relevant API enabled. An optional user-provided source URL is provenance, not authorization. [F4]

Figma plugin data is scoped to the plugin identity and has storage limits. Store only small mappings/aliases there; do not treat it as secret storage or an asset database. Preserve a consistent development-plugin ID or explicitly migrate mapping data. [F3][F7]

Figma document/node duplication can preserve plugin metadata. On first local association of a document, explicitly choose **New design namespace** or **Continue known design**. Reassociation cannot silently claim an existing workspace's generated ownership. When file identity is unavailable, copied documents may be indistinguishable; require this user choice rather than promising perfect clone detection. New duplicated nodes get their own source IDs and need collision-free public aliases. Instance detachment/replacement must not be treated as a guaranteed rename.

### 6.3 Consistent extraction and transfer

Document reading and asset/reference export can span asynchronous work. Guard capture with change observation and canonical before/after fingerprints of the selected graph, mappings, and relevant dependencies. Limit retries; report `SOURCE_CHANGED_DURING_CAPTURE` rather than publishing mixed revisions.

Figma's node export API provides asset/reference bytes. Retain export settings and content hashes in the bundle. A reference image does not replace structured nodes. [F5]

Transfer is staged: begin publication, upload only missing hash-addressed blobs, then finalize the manifest. Finalization verifies all hashes, byte limits, and required dependencies. Interrupted or corrupt uploads never become published snapshots. Retries are idempotent and incomplete transfers expire safely.

While the plugin is closed, stored snapshots remain usable. The bridge must never describe them as a live read of Figma. Fresh captures require the plugin to run again.

### 6.4 Determinism and cache keys

Derive the snapshot ID from canonical semantic design data, approved mappings, and content-addressed asset/reference inputs. Keep capture times, request IDs, pairing sessions, and machine paths out of the canonical payload.

A conversion key additionally includes the snapshot ID, converter version, effective target profile, Gum/codegen version, external-component hashes, font assets and generation settings, and relevant rendering environment for preview caches. Normalization rules cover key ordering, invariant number formatting, negative zero, line endings, stable filenames, and insignificant metadata. Reject non-finite numbers.

Repeated identical input MUST produce byte-identical managed text output and reusable asset bytes under the pinned pipeline. Do not rewrite ownership manifests or committed snapshots solely because another request ran. An unchanged export must produce no repository diff. Preview baselines may be platform-specific where rasterization differs, and must record that fact rather than falsely claiming cross-platform pixel identity.

Snapshots retained in source control are frozen reproduction inputs, not a second editable design source. Applying to a second workspace uses a separate ownership manifest and cannot grant access to the first workspace.

## 7. Conversion support and failure policy

The Gum guide is the starting reference, not evidence of a complete one-to-one Figma mapping. In particular, padding, cross-axis alignment, and rotation require translation. [G5]

### 7.1 Initial support matrix

| Figma feature | Initial conversion rule |
|---|---|
| Frame explicitly selected as an export root | Gum Screen. Frames nested within that exported subtree remain containers, not nested Screens. |
| Frame/group hierarchy | Preserve transform, clipping, order, and parenting using supported containers. |
| Fixed dimensions | Absolute dimensions. |
| Fill dimensions | Parent-relative dimensions or proportional sharing, according to the source layout. |
| Hug dimensions | Children-relative sizing with explicit insets; reject parent/child dependency cycles. |
| Horizontal/vertical Auto Layout | Gum stack layout, explicit spacing, and translated per-child cross-axis alignment. |
| Padding | Explicit outer/inner-container lowering where needed, with no visible background participating as a layout child. |
| Constraints and min/max | Translate supported anchoring, dimension, and limit properties; validate at multiple viewport sizes. |
| Simple solid background | A native visual child behind content; do not assign nonexistent fill behavior to an invisible Container. |
| Plain uniform-style text | Native Text with explicit font mapping, sizing, alignment, wrapping, and supported metrics. |
| Raster image | Sprite with recorded crop, sizing, scale, and asset hash. |
| Reusable component/instance | Shared Gum component definition plus supported instance overrides. |
| Approved interactive role | Gum Forms or registered custom control contract, including required children and behavior configuration. |
| Visual variants | Explicit state/category mapping, not inference from appearance alone. |
| Scroll region | Registered scrolling-control adapter with real content/viewport behavior; clipping alone is insufficient. |
| Nine-slice skin | Explicitly configured source image and slice metadata, validated by the target adapter. |
| Decorative vector/effect | Native representation only when supported by the pinned target; otherwise an approved asset fallback. |

For a padded container with fixed/fill dimensions, the inner region is offset by left/top insets and reduced by opposing insets. For hug sizing, the outer dimensions derive from content plus insets without making that content depend circularly on the outer size. Test asymmetric padding and nested combinations; do not flatten everything into absolute coordinates.

Source rotation/transform conventions must be converted and tested. Compound skew, unsupported transforms, or inconsistent hit-test geometry are blockers for interactive content, not opportunities for an unannounced approximation.

### 7.2 Explicit v1 restrictions

Advanced grids, wrapping combinations not covered by fixtures, arbitrary vector effects/masks, mixed-style text, variable-font behavior not verified by the target, and animated prototype transitions are unsupported until a tested rule exists.

An unsupported feature produces either an error or a documented, approved decorative fallback. Publication for diagnosis may still succeed; planning/apply remain blocked until resolved. It must not disappear from the output. Rasterizing an entire screen, interactive control, dynamic text field, or layout subtree containing those elements is prohibited.

Decorative fallback approval is stored against the node and feature fingerprint. Material changes invalidate the approval. Show which editability/resolution behavior is lost.

An image export does not solve a missing runtime font. The developer must provide a usable mapped font asset/configuration. Do not claim that the plugin can export a locally installed font binary from Figma.

### 7.3 Existing components versus generated components

There are two distinct ownership modes.

**Generated component:** Its visuals and exposed design properties come from Figma. It may compose existing native controls through a validated adapter.

**Referenced component:** Its implementation remains developer-owned. The export may use supported exposed properties, states, slots, and skins but must not overwrite the component definition. A Figma design that exceeds that contract needs a generated wrapper/skin or a mapping change.

Referencing an existing control preserves its behavior; it does not authorize rewriting its implementation. Figma remains authoritative for the mapped visual surface; choosing a referenced component explicitly limits that surface to its declared skin/property/state contract. The project catalog must describe public properties, required child structure, content slots, states, and supported events for each adapter.

## 8. States, controls, and behavior connection points

Start with the controls required by the standalone sample: Button, TextBox, a scrolling list/ScrollViewer adapter, native text/images, and reusable visual components. Other controls are supported only when an adapter and tests exist.

State mapping is explicit and target-specific. For example, a Figma normal/hover/pressed set may map to a Gum button's enabled/highlighted/pushed states. Inspect the pinned control definition for exact required category/state names, including focused/disabled combinations. Do not assume that a visual component becomes interactive merely because its states have familiar names. Gum's Button exposes a `ButtonCategory` contract. [G7]

Variant axes with overlapping property assignments must have an explicit precedence/composition rule or a supported combination table. Do not emit independent categories that silently overwrite each other. Reject missing required states and unsupported combinations, or let the designer explicitly approve a visible fallback mapping to an existing state.

Named connection points are metadata, not embedded code. Examples are a button action `StartMatch`, text value `PlayerName`, and list data `AvailableModes`. Declare a stable key, control role, value/event kind, and expected value shape. No JavaScript, C#, expression evaluator, or arbitrary path is accepted in those fields.

Generate typed access/contracts where supported and a machine-readable contract manifest. Reuse Gum's generated members; any additional bridge-generated facade is a small separate managed file with stable aliases, not a replacement Gum code generator. The external agent implements the application's subscriptions, navigation, asynchronous calls, and data binding in developer-owned code. When the UI is recreated or reloaded, integration tests must catch duplicate subscriptions and lost state.

Figma sample data is a design-time default. Runtime data may replace it without becoming a design conflict. Platform input/focus behavior belongs in the target adapter and runtime integration, not in the Figma layout converter.

## 9. Regeneration and source ownership

### 9.1 Managed surface

Maintain an ownership manifest listing every generated element, generated C# file, asset, project-reference entry, source identity, public contract, and last-written content hash.

Native Gum output remains loadable/editable in Gum. However, edits to Figma-managed visuals made there are temporary experiments. On the next export, detect and report them; the user may explicitly replace them with the Figma result. There is no reverse merge.

Developer-owned code, unmapped Gum elements, existing reusable controls, and unrelated project settings are protected.

### 9.2 Update algorithm

1. Resolve the explicit immutable snapshot, selected workspace/profile, approved mappings, and compatible toolchain.
2. Inspect the current repository and compare managed-file hashes with the ownership baseline.
3. Generate candidate native Gum files, assets, code, and contract changes in an isolated staging directory. Copy or safely reference trusted dependencies, and rewrite staged generator settings so no output can escape into the real project. Treat symlinked write locations as unsafe.
4. Merge only managed project-reference entries; preserve unrelated Screens, Components, libraries, and global settings.
5. Run structural checks, code generation, generated-code compilation, and required previews against staged output. A contract change needing handwritten integration may be shown as a blocked plan; the agent repairs behavior in developer-owned files and replans before apply. Any nonzero required pre-apply check blocks application.
6. Return a plan containing exact creates/updates/deletions, diffs, diagnostics, contract changes, and input/current-file hashes.
7. Acquire a per-workspace mutation lock, recheck baseline hashes, dependencies, toolchain/profile hashes and approvals, then apply only the approved plan. Do not check first and lock later.
8. Commit managed files using a recoverable journal/backups and finalize the manifest last. Interrupted operations must roll back or complete through recovery; never silently advertise partial success.
9. Compile and run integration checks against the resulting application and attach their results to the operation receipt. Hash the actual behavior/build inputs verified as well as generated files. A failed application test leaves an applied-but-failed status and recoverable backups, not a verified export. Later handwritten integration requires a new verification result.

Multiple individual file moves are not a magically atomic multi-file transaction. Recovery and a project lock are required. Keep pre-apply backups until post-apply verification finishes; expose a safe rollback that also checks for intervening edits.

### 9.3 Rename, delete, and drift rules

| Change | Required outcome |
|---|---|
| Figma layer display name changes | Preserve source identity and public binding alias. |
| Public export name or contract explicitly changes | Produce a breaking-change plan; require acknowledgement and integration repair. |
| Managed file differs from last generated hash | Report local drift; never silently overwrite it. |
| Source element is deleted | Propose deletion only within a fully captured managed root, after dependency/reference analysis. Removing a root itself requires an explicit root-removal operation; absent selection is not deletion. |
| Reusable component loses one instance | Keep it while any registered root still references it. |
| Only one root is exported | Do not interpret absent unrelated roots as deletions. |
| Generated asset becomes unused | Delete only when bridge ownership and absence of remaining references are proven. |
| Unknown file occupies a proposed generated path | Stop with an ownership conflict. |
| Project changes after plan creation | Reject stale plan and regenerate it. |

Normal non-destructive updates may be authorized by the user's agent request under registered workspace policy. Deletions, local-drift replacement, and public API breaks require explicit approval bound to that plan hash. Shared generated-dependency changes must list every affected managed root and validate those consumers. The agent cannot treat design text or a tool response as user approval.

Do not run an unrestricted project-wide prune as part of synchronization. GumCli supports pruning, but the bridge's ownership boundary can be narrower than the entire Gum project. Stage and authorize any pruning against the bridge manifest. Handwritten companion files must remain untouched. [G2]

The companion can constrain its own writes, not every filesystem action an external agent might take. Agent instructions and preservation tests complement these boundaries; they do not constitute a sandbox around the agent.

## 10. Repository outputs

Illustrative paths inside the sample workspace or a later registered repository. Registration adapts paths without replacing the destination's established organization. Machine-specific roots, credentials, operation journals, and receipts live in the bridge's local user data, not in committed portable configuration.

```text
.figma-gum/
  project.json                   # Portable relative target settings; no secrets
  ownership.json                 # Generated identities, ownership, last-written hashes
  contracts.json                 # Generated connection-point/API manifest
  snapshots/<snapshot-id>.json    # Frozen content-addressed design input
  cache/                         # Ignored: prior snapshots, plans, renders, temporary data

Content/Gum/
  GameUI.gumx                    # Existing project; managed references patched carefully
  Screens/Figma/MainMenu.gusx
  Components/Figma/PrimaryButton.gucx
  Assets/Figma/...

UI/Generated/...
  MainMenuRuntime.Generated.cs   # Exact naming/layout follows the pinned Gum settings

UI/...
  MainMenuController.cs           # Developer-owned behavior; never regenerated
```

Version-control the last-applied frozen snapshots, mappings embedded in them, ownership/contracts, native Gum files, needed assets, and generated C# for the initial workflow. The snapshot is a reproducibility record of Figma, not another editable design source. Heavy preview caches and credentials remain untracked.

Use Gum's existing code-generation settings. Auto-detection exists, but inspect its selected project, root namespace, output library, and output directories before accepting it. Never assume the nearest `.csproj` is the intended game project. [G8]

If the pinned generator emits custom stubs as well as generated files, keep them staged and protect existing custom files. Creating a new handwritten integration stub is a separately visible action, not permission to overwrite one on subsequent exports.

## 11. Transport and agent interfaces

All interface names below are required proposed product operations, not existing Gum commands. Protocol schemas define full field types before implementation. Ordinary application handlers are the implementation; HTTP, CLI, and MCP only adapt calls/results.

### 11.1 Local process modes

```text
gumbridge serve
gumbridge sample init --directory <new-sample-workspace>
gumbridge workspace register --directory <trusted-existing-root>
gumbridge mcp
```

These are product commands to implement. `sample init` creates an isolated writable copy of the bundled sample, never modifies the distributed template, and refuses a conflicting nonempty directory. Registration collects explicit target paths and trust settings instead of assuming the closest `.csproj` is correct.

CLI and MCP modes discover the per-user running host through a protected local descriptor. They return `BRIDGE_UNAVAILABLE` when it is not running. They must not silently start a second writer. Keep endpoint/credential discovery out of the repository and out of Figma document data.

### 11.2 Plugin-facing host API

| API group | Required behavior |
|---|---|
| Pair session | Redeem an expiring one-time challenge initiated locally; return a scoped in-memory plugin session. |
| List allowed workspaces / catalog | Include Sample workspace; return labels, capability status, and versioned catalog data, not arbitrary paths. |
| Begin / upload blobs / finalize publication | Stage and validate a design bundle, then publish its immutable ID. No target-file updates. |
| Analyze snapshot | Return target-specific compatibility/mapping diagnostics for an explicit snapshot/profile. |
| Create plan | Generate and validate staged output, then return a plan ID, changes, approvals, and preview references. |
| Read operation / artifact | Return status, diagnostics, and bounded image/JSON artifacts authorized for this workspace/session. |
| Review plan | Display exact changes and record approval for a specific plan hash; never approve an unspecified future change. |
| Cancel operation / revoke session | Cancel before the protected apply step or revoke future requests. Recovery rules govern an interrupted apply. |

Use versioned routes, for example `/v1/...`, and typed message envelopes. Do not add a general filesystem endpoint, shell endpoint, code-evaluation endpoint, or remotely callable Figma-edit endpoint.

The UI may request analysis and a preview plan directly. Application remains an explicit agent/CLI operation against an authorized plan; clicking Publish is never equivalent to Apply.

### 11.3 MCP tools and CLI equivalents

| MCP tool | CLI command | Contract |
|---|---|---|
| `get_project_status` | `gumbridge doctor --workspace <id>` | Host, versions, fonts, backend, compatibility, selected profile. |
| `list_published_snapshots` | `gumbridge snapshots --workspace <id>` | Bounded/paged published exports visible to the caller; include blocked and last-applied status. |
| `get_design_snapshot` | `gumbridge inspect --snapshot <id>` | Exact structured source, mappings, contracts, dependencies, diagnostics, and artifact references. |
| `get_control_catalog` | `gumbridge catalog --workspace <id>` | The resolved versioned control/capability catalog. |
| `plan_sync` | `gumbridge plan --workspace <id> --snapshot <id>` | Staged outputs, checks, diffs, previews, and immutable plan ID; no target writes. |
| `apply_sync` | `gumbridge apply --plan <id>` | Apply the authorized immutable plan with baseline rechecks and recovery protection. |
| `verify_ui` | `gumbridge verify --receipt <id>` | Structural/build/runtime/visual results tied to current output and behavior hashes. |
| `get_operation_result` | `gumbridge result --operation <id>` | Current/final result and evidence references. |
| `read_artifact` | `gumbridge artifact --id <id>` | Authorized bounded text/image content, or a known local cache path for CLI use; never an arbitrary file read. |
| `cancel_operation` | `gumbridge cancel --operation <id>` | Acknowledge safe cancellation or report why an apply must complete/recover first. |

Mutation tools always require immutable IDs. Discovery may report the latest publication, but a plan cannot silently switch snapshots midway. Explicit root removal is represented by `removeManagedRootIds` on `plan_sync` (CLI: repeatable `--remove-root <id>`); it uses the last-applied snapshot as provenance, verifies surviving references, and requires destructive-change approval. Omission from a publication never populates that list automatically. Large design responses must support bounded node/root/dependency sections rather than dumping unbounded data into agent context. MCP image results must return actual readable image content or supported resource access, not only an opaque ID an agent cannot open.

Use the official C# MCP SDK at a pinned compatible version. Let it handle initialization, tool discovery, protocol negotiation, and framing. MCP stdio requires protocol-only stdout; logs and child-process output must go to captured artifacts or stderr, never contaminate MCP framing. [M1][M2]

CLI stdout is structured JSON and stderr is for diagnostics. Define stable CLI exit codes: `0` successful completion, `1` blocked/failed operation, `2` invalid request or compatibility setup, `3` missing/denied local connection, `4` cancelled. The CLI may wait for an operation; a returned operation ID alone is acceptance, not verified success.

### 11.4 Operations and error semantics

Long-running work returns an operation ID with phase/progress, and can be polled by UI or agent. This is behavior of the proposed application, not a requirement for a cloud queue. Start with one target-mutating operation per workspace and bounded conversion workers.

Persist `Queued`, `Running`, `PlanReady`, `Applying`, `AppliedUnverified`, `Verified`, `Failed`, `Cancelled`, and `RecoveryRequired` distinctly. A retry of an already applied plan returns its existing receipt after checking state; it must not reapply blindly. An applied receipt remains historical even if files later change; new verification must reflect current hashes.

Each diagnostic contains a stable code, severity, source node/property when relevant, affected target, explanation, and allowed remediation. Initial codes include `UNSUPPORTED_FEATURE`, `MISSING_FONT`, `UNRESOLVED_COMPONENT`, `INVALID_CONTROL_CONTRACT`, `SOURCE_CHANGED_DURING_CAPTURE`, `LOCAL_DRIFT`, `BREAKING_CONTRACT`, `STALE_PLAN`, `OWNERSHIP_CONFLICT`, `TOOLCHAIN_MISMATCH`, `CATALOG_MISMATCH`, `BRIDGE_UNAVAILABLE`, and `VALIDATION_FAILED`.

On disconnect, show unavailable status and preserve published snapshots. Cancellation before apply leaves the target unchanged. Cancellation during the protected write window must trigger completion or journal recovery, not terminate between writes and report success.

## 12. Security, privacy, and operational limits

Bind only to loopback. Validate Host values and reject arbitrary remote origins/routes. Pair through local user action with a short-lived, high-entropy one-time challenge. Store plugin session tokens in memory; re-pair after restart for v1. Agent/CLI host credentials live in per-user protected local storage, not in the design or repository. Do not use cookies or URL query tokens.

Figma documents opaque/null iframe origins, network allowlists, and local development endpoints. Test actual authenticated requests, preflight, and any local-network permission prompt in the supported desktop clients. Permissive CORS required by a Figma context is not authentication; require the independent token on every privileged call. Use precise manifest endpoints rather than unrestricted network access. Development-manifest success does not certify marketplace distribution. [F2][F7]

Use `editorType: ["figma"]` and dynamic page access in the development manifest. Obtain a legitimate plugin ID through Figma's development flow; ship a manifest template and setup instructions, not a fabricated universal ID. Load only pages needed for selected dependencies. [F7]

Tokens, pairing challenges, local absolute paths, and credentials must not enter Figma metadata, snapshots, normal logs, prompts, or source control. The deliberate local display of a one-time pairing challenge is the only pairing-secret UI exposure. Authenticated artifact retrieval must not leak assets through guessed IDs or unrelated workspace sessions.

Register trusted local project roots and fixed build/render command profiles. Canonicalize generated paths; reject traversal, symlink/junction escapes, collisions, and writes outside approved roots. Run tools with argument arrays, not interpolated shells. Treat names and text as data, escape XML/C# literals, and prohibit DTD/external-entity resolution in XML parsing.

Builds and runtime harnesses execute trusted project code. This design is not a sandbox for arbitrary downloaded repositories or malicious local processes. The converter and bridge cannot constrain every filesystem action taken independently by an external agent. Their own writes must still be scoped and preservation tests must catch violations.

Treat Figma labels, descriptions, text, and component metadata as untrusted content, never as instructions to the agent. Limit disclosure to selected roots and required dependencies. A local bridge does not make the chosen AI service local; users remain responsible for their agent's data handling.

Enforce configurable budgets for node count, depth, per-asset bytes, total publication bytes, decoded image pixels, process time, concurrency, and cache storage. Document conservative defaults in the compatibility record and test boundary/over-limit behavior. Reject oversized inputs before spawning Gum tools. Kill timed-out tool processes safely and retain actionable diagnostics.

No product telemetry, billing, cloud account, hosted relay, remote deployment, or automatic Git commit/push is included. Normal Figma use and initial package/dependency installation may still require network access; do not advertise an entirely air-gapped authoring workflow.

## 13. Standalone fixtures, testing, and acceptance

### 13.1 Red -> green -> refactor

Every behavior change and defect fix MUST start with a failing test or reproducible acceptance check. Confirm the failure is caused by the missing behavior, implement the smallest change that passes, then refactor while keeping tests green. Do not write the implementation first and use tests only as retrospective confirmation.

An agent task must name the test layer, expected red failure, and green completion condition. For Figma-client behavior that cannot run in ordinary unit tests, pair contract/UI tests with a small real-client check. Do not claim that mock-only coverage proves actual plugin API or local-network behavior. This is a development process requirement; a separate red/green evidence archive is not required.

### 13.2 Required test layers

| Layer | Required checks |
|---|---|
| Architecture | Allowed dependencies, core purity, one managed writer, no application/agent dependencies in conversion. |
| Contract | Valid/invalid schemas, TS/C# parity, stable hashing, version handling, malformed data. |
| Plugin | Empty/offline states, selection, mapping persistence, alias conflicts, publish freshness, transport errors, stale previews. |
| Conversion | Every supported layout/paint/text/component/state rule has positive and negative fixtures. |
| Managed files | No-op export, local drift, handwritten preservation, partial-root export, shared dependencies, interrupted apply, stale plan. |
| Toolchain | Native loading, Gum checks, partial-generation failure, font readiness, generated-code compilation. |
| Runtime | Button input/focus/disabled states, text entry, scrolling, resize, event binding, teardown/recreation. |
| Visual | Figma reference versus Gum at matching viewport/state/data/font settings; report geometry, text, and image differences separately. |
| Transport/security | MCP discovery/results/images, CLI parity, auth, CORS/manifest in real clients, denied paths, limits and hostile text. |

Pure conversion and ownership suites must run without Figma or an AI service. End-to-end Figma smoke tests require the real desktop client. Rendering tests require documented graphics/native dependencies; an unavailable renderer is an explicit unrun test, not a pass.

### 13.3 Bundled sample and design fixtures

The implementation team MUST supply the entire fixture set. Do not ask the product owner for a production design or game to complete v1.

The main menu contains a title, small image/logo, reusable primary and secondary buttons, text input, and scrollable item list. Include required normal, hover, pressed, focused, and disabled control states. Add a second small screen sharing a component so partial-export and dependency lifecycle tests are real.

The sample app has a developer-owned controller that handles `StartMatch` with a visible counter, supplies `PlayerName` and `AvailableModes`, and unsubscribes correctly when the screen is disposed. No actual networking, matchmaking, authentication, or game backend is needed.

Create corresponding Figma reference frames at 1280x720 and 1024x768. Mark one as canonical conversion input and the other as a validation reference. Produce both using actual layout behavior; never stretch one screenshot or implement two unrelated hard-coded Gum layouts. A structural breakpoint absent from the canonical design's rules is a diagnostic, not an inferred feature.

The sample-design builder, static source assets, extraction fixtures, expected Gum results, and baseline screenshots are versioned with provenance. Synthetic unit-test snapshots supplement, but do not replace, at least one real Figma capture. Ship no secret or private design content. Choose sample assets/fonts whose redistribution is permitted and retain required notices; do not extract font binaries from Figma.

For simple geometry, the default fixture target is at most one logical pixel of error. Set explicit reviewed text/rasterization tolerances per environment. A threshold change requires review. Compiling is not proof of fidelity; an image match is not proof of functional controls.

### 13.4 Acceptance cases

| ID | Given / when | Required result |
|---|---|---|
| A01 | Open the plugin in a blank document with no bridge or game. | Useful empty state, mapping UI and built-in catalog work; preview/publish requirements are clear. |
| A02 | Explicitly create the sample design, initialize Sample workspace, and pair. | Sample assets/controls/references are available without touching existing user layers or a game repository. |
| A03 | Publish the supported menu and request generation through CLI/MCP. | Native Gum loads, generated C# compiles, sample runtime displays the menu, preview returns to plugin. |
| A04 | Repeat identical design/mappings/toolchain inputs. | Zero managed-file diff, no timestamp-only manifest changes, no duplicate assets/components. |
| A05 | Change button style, spacing, and label in Figma after binding its handler. | Visuals update; handwritten handler is byte-for-byte unchanged and fires exactly once. |
| A06 | Rename only a Figma layer display name. | Public alias/binding identity remains stable and integration compiles. |
| A07 | Explicitly rename a public contract or delete a referenced control. | Breaking-change plan is visible and requires approval; no silent handler loss. |
| A08 | Edit generated visuals locally, or place an unknown file at an output path. | Report drift/ownership conflict; no silent replacement. |
| A09 | Share one component across two screens, then export only one screen. | Reuse the definition; do not prune the other screen or still-referenced assets. |
| A10 | Input, focus, disabled behavior, text entry, scrolling, and screen recreation. | Native behavior works; no duplicate subscriptions or clipped-but-nonfunctional scroll region. |
| A11 | Render both reference sizes and required states. | Layout responds; reviewed visual criteria pass; preview identifies exact case/output. |
| A12 | Use unsupported effects on decorative and interactive nodes. | Decorative fallback requires scoped approval; unsupported interaction blocks generation. |
| A13 | Change source during capture, or destination after planning. | Reject mixed capture or stale plan; leave last good target unchanged. |
| A14 | Interrupt apply, restart host, retry an operation, or request rollback. | Recover consistently; no partial-success claim, duplicate writes, or overwriting intervening edits. |
| A15 | Close the plugin after publication. | Agent/CLI can use stored snapshot; bridge clearly reports captured, not live, source. |
| A16 | Use malformed paths, oversized assets, invalid tokens, hostile text, or unowned artifact IDs. | Reject safely without code execution, path escape, or disclosure. |
| A17 | Use equivalent CLI and MCP requests and retrieve preview images. | Same plan/result semantics; actual artifacts are readable; MCP stdout stays valid. |
| A18 | Copy a document/node, detach an instance, or change catalog/target. | Ambiguous identity or incompatible mapping is surfaced; no automatic ownership takeover. |
| A19 | Run real Figma desktop communication and sample rendering on macOS and Windows. | Both environments pass their documented checks; missing coverage is explicitly incomplete. |
| A20 | Complete the sample lifecycle using one actual external coding agent. | Agent pulls exact export, invokes generation, writes only sample behavior integration, and verifies safe regeneration. |

### 13.5 Release completion

V1 is complete when the standalone acceptance cases pass, setup is reproducible, and compatibility/limits are documented. A named production game is not required. Use any available compatible real agent for A20 and record its identity/version; passing one client does not certify every client.

A later FlatRedBall2 integration validates that consumer's project conventions and Gum/backend versions. It must not force game-specific references into Conversion or reopen already proven core rules.

## 14. Ordered, agent-sized implementation plan

Execute in the order below. Later tasks build on completed earlier tasks; do not skip to MCP scaffolding before proving native Gum output. Every task follows Section 13.1. Where a row exceeds one focused change with one testable outcome, split it and preserve order rather than broadening an agent's responsibility.

| ID | Deliverable | Red test / green exit condition |
|---|---|---|
| T01 | Repository skeleton, pinned SDK/package scaffolding, dependency rules. | Architecture test rejects a forbidden core dependency, then passes with correct project references. |
| T02 | Compatibility record and minimal native Gum sample. | Missing-tool/font/load check fails; pinned toolchain loads and renders a simple sample. Record macOS/Windows requirements. |
| T03 | Development-plugin shell and offline/empty views. | Empty document previously fails/blocks; panel now opens with no workspace or bridge. |
| T04 | Versioned request/snapshot/catalog/diagnostic schema skeleton and TS/C# vectors. | Both sides reject the same invalid examples and accept the same minimal valid input. Extend schemas with each use case. |
| T05 | Bridge host pairing and one authenticated request from real Figma. | Missing/invalid credential is denied; real desktop plugin round trip passes on supported OSes. |
| T06 | Bundled sample workspace initialization and local registration. | Conflicting directory is rejected; a new directory gets a working isolated sample, not a required game association. |
| T07 | Thin frame/text/image extraction and canonical hashing. | Selection/name/capture tests fail, then produce bounded typed snapshots with stable hashes. |
| T08 | Staged blob publication and snapshot store. | Missing/corrupt blob cannot publish; complete retried upload finalizes exactly once. |
| T09 | Minimal pure conversion and native serialization. | Golden frame/text/image fixture fails, then loads through Gum with expected output. |
| T10 | Preview operation and artifact delivery to plugin. | Missing/outdated artifact cases fail correctly; a real selected frame becomes a staged Gum preview end to end. |
| T11 | Fixed/fill sizing, anchors, and min/max. | Focused geometry fixtures pass at both viewport sizes. |
| T12 | Stack spacing, cross-axis alignment, padding, and hug sizing. | Nested/asymmetric cases pass; dependency cycles are rejected. Split by rule as necessary. |
| T13 | Clipping, supported image crop/scale, transforms, and negative cases. | Supported geometry matches; unsupported interactive transforms diagnose instead of flattening. |
| T14 | Font/asset mapping, deterministic font inputs, and fallback review UI. | Missing fonts/assets block; approved decorative fallback is scoped and traceable. |
| T15 | Component catalog, document mappings, and stable aliases. | Built-in offline catalog works; custom catalog mismatch and alias collisions are explicit. |
| T16 | Shared components, dependencies, instances, and overrides. | Two screens share one definition without duplicate output or unauthorized component rewrites. |
| T17 | Button adapter and state/property/connection contracts. | Required states and real click/focus/disabled behavior pass in the sample. |
| T18 | TextBox and scroll adapters. | Text entry and actual scrolling pass; clipping-only substitutes fail tests. |
| T19 | Explicit sample-design creator and complete reference fixture set. | Creates an isolated page and realistic responsive references; repeat invocation cannot damage user layers. |
| T20 | Immutable sync plan, ownership baseline, and contract diff. | Managed/unmanaged conflicts and API breaks surface before any destination write. |
| T21 | Managed writer, lock, stale-plan checks, and recovery journal. | Fault-injection/retry tests fail, then recover without leaving partial ownership or touching handwritten files. |
| T22 | Rename/delete/shared-reference lifecycle and rollback. | Partial-root export cannot prune unrelated files; rollback respects intervening changes. |
| T23 | Sample behavior integration and preservation regression. | A05 fails before safe ownership/integration, then handler bytes remain unchanged and event count is one. |
| T24 | Full CLI surface over host operations. | Invalid/missing IDs, exit codes, wait/result semantics and artifact access pass without an AI service. |
| T25 | Thin MCP stdio surface using the same host client. | Discovery, framing, tool schemas, image results and CLI/MCP parity pass; no second conversion/writer implementation. |
| T26 | Complete review UI, statuses, approvals, cancellation, and freshness. | Stale previews and dangerous update plans cannot masquerade as verified/approved. |
| T27 | Security limits, malformed-input tests, cross-platform runtime suite. | Boundary and over-limit cases pass; actual client/toolchain tests close both OS compatibility gates. |
| T28 | Real external-agent sample acceptance. | A20 and repeat-export behavior pass with the chosen available client; record exact support tested. |
| T29 | Packaging, setup, troubleshooting, and agent handoff guide. | A clean environment installs development plugin + bridge, creates sample, publishes, renders and regenerates using documented steps. |

Milestones: **T10** proves the thin end-to-end slice; **T19** completes sample design/control coverage; **T23** proves safe regeneration; **T29** completes the standalone v1. Early tests may use minimal local scaffolds; do not wait for the full sample-design creator to prove the first slice.

Do not commit credentials, generated build artifacts, enormous preview caches, or private Figma data. Do not implement a generic shell tool, cloud deployment, production-game dependencies, or a custom C# UI generator as shortcuts.

Task completion requires the named tests to pass. A task blocked by an unavailable external client/OS must report exactly what was run and what remains untested; it must not label the whole acceptance case complete.

## 15. Explicit exclusions and controlled extensions

V1 excludes Gum -> Figma synchronization, embedded AI chat, autonomous redesign, full Figma feature coverage, code-only canonical output, application/game logic inside the converter, Figma prototype/animation reproduction, runtime theme switching, public marketplace publication, hosted bridging, Linux/browser certification, and broad multi-engine certification.

Automatic live synchronization is deferred. Handoff is explicit snapshot publication, not a promise that an agent always sees the current document. No production game, private Figma design, existing GitHub repository, or owner-selected agent is a development prerequisite.

A new control, layout mode, target backend, or transport must extend its owning module, add contract/behavior fixtures, and preserve the same snapshot/ownership boundaries. Do not use feature growth as a reason to move conversion into the plugin UI or file management into a catch-all bridge class.

## 16. Definition of done and agent handoff

### 16.1 Required deliverables

Deliver the development-loadable Figma plugin; local bridge with host, CLI, and MCP modes; versioned schemas and built-in catalog; deterministic converter and Gum adapter; guarded regeneration; bundled sample-design creator and Gum application; positive/negative fixtures; red-then-green development coverage; macOS/Windows compatibility record; and reproducible setup/agent instructions.

There are no outstanding product-owner identifiers needed to start. Implementation resolves toolchain pins and low-level library choices through T01-T05. Production integrations are a subsequent use of the product, not missing inputs to this specification.

The release documentation must distinguish implemented-and-tested functionality, known unsupported features, and any environment-specific unrun checks. Do not claim compatibility from reading documentation alone.

### 16.2 Copyable implementation prompt

> Implement Figma-to-Gum Bridge specification v0.2 in Section 14 order. Begin with T01-T05 and prove the T10 selection-to-native-Gum-preview slice before widening scope. Build a standalone Figma plugin in TypeScript and a modular C#/.NET 10 local bridge. Supply the sample Figma-design creator and Gum test application yourself; do not require a production game repository or an existing design. Follow red -> green -> refactor for every change. Keep conversion pure and deterministic, reuse pinned Gum tooling, and keep MCP/CLI thin over one host and one managed writer. Figma owns visual design; protect handwritten behavior and unrelated Gum files. Do not hand-patch generated visuals to pass screenshots. Every supported feature needs fixtures and every unsupported feature needs a diagnostic. Prove unchanged exports are no-ops and styling updates preserve a handwritten click handler that fires once. Run the standalone acceptance cases, document exact compatibility tested, and report unrun tests honestly. Do not add cloud infrastructure, reverse sync, an embedded model, or application logic to the converter.

### 16.3 Change record

v0.2 replaces the v0.1 production-pilot assumption with standalone completion. It records the approved two-product architecture, adds offline startup and self-supplied sample creation, separates internal modules, defines one host/writer and thin client modes, decouples snapshots from local project identity, clarifies artifact access and freshness, and adds ordered red/green implementation tasks.

## Sources and inspection record

Source baseline: September 21, 2026. Gum references are pinned to the repository commit used in v0.1; codegen, screenshot and font pages were rechecked for v0.2. Figma execution/network/manifest/data/export documentation and MCP transport guidance were consulted for this revision. Sources support upstream API constraints; normative product requirements are design decisions, not claims of an existing implementation. The prior v0.1 specification was used as the base and is superseded by this document.

- [G1] GumCli command reference: `https://github.com/vchelaru/Gum/blob/554ca3a8b1779b38b0c81f98848bd55cf48a69fe/docs/cli/README.md`
- [G2] Code generation, partial failures, and pruning: `https://github.com/vchelaru/Gum/blob/554ca3a8b1779b38b0c81f98848bd55cf48a69fe/docs/cli/codegen.md`
- [G3] Screenshot command and backend/dimension options: `https://github.com/vchelaru/Gum/blob/554ca3a8b1779b38b0c81f98848bd55cf48a69fe/docs/cli/screenshot.md`
- [G4] Font generation backends: `https://github.com/vchelaru/Gum/blob/554ca3a8b1779b38b0c81f98848bd55cf48a69fe/docs/cli/fonts.md`
- [G5] Figma-to-Gum layout concepts: `https://github.com/vchelaru/Gum/blob/554ca3a8b1779b38b0c81f98848bd55cf48a69fe/docs/gum-tool/readme/for-figma-users.md`
- [G6] Existing HTML conversion and fidelity tooling: `https://github.com/vchelaru/Gum/blob/554ca3a8b1779b38b0c81f98848bd55cf48a69fe/Tool/HtmlToGum/README.md`
- [G7] Button category contract (matching source excerpt inspected): `https://github.com/vchelaru/Gum/blob/554ca3a8b1779b38b0c81f98848bd55cf48a69fe/MonoGameGum/Forms/Controls/Button.cs`
- [G8] Code generation initialization and project detection: `https://github.com/vchelaru/Gum/blob/554ca3a8b1779b38b0c81f98848bd55cf48a69fe/docs/cli/codegen-init.md`
- [G9] Inspected upstream commit: `https://github.com/vchelaru/Gum/commit/554ca3a8b1779b38b0c81f98848bd55cf48a69fe`
- [F1] Figma plugin execution contexts: `https://developers.figma.com/docs/plugins/how-plugins-run/`
- [F2] Figma network requests, opaque origin, and manifest allowlists: `https://developers.figma.com/docs/plugins/making-network-requests/`
- [F3] Plugin-data persistence, access, and size limitations: `https://developers.figma.com/docs/plugins/api/properties/nodes-setplugindata/`
- [F4] Figma global API and restricted file-key access: `https://developers.figma.com/docs/plugins/api/figma/`
- [F5] Figma node export: `https://developers.figma.com/docs/plugins/api/properties/nodes-exportasync/`
- [F7] Figma manifest, development plugin identity, document/network access: `https://developers.figma.com/docs/plugins/manifest/`
- [M1] MCP transport reference used for stdio framing: `https://modelcontextprotocol.io/specification/2025-11-25/basic/transports`
- [M2] Official MCP C# SDK documentation entry point: `https://csharp.sdk.modelcontextprotocol.io/`
