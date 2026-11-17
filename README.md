# BonniePDF MCP

A local MCP server for creating, inspecting and refining BonniePDF JSON documents from Claude Code, Codex and other MCP clients. It retrieves existing examples and generated API documentation, validates definitions through the library, previews selected pages and writes PDF artifacts.

The assistant writes the content and edits. BonniePDF measures, paginates and renders it. This server does not need an AI API key or a hosted service.

## Windows installer

The Inno Setup installer includes the compiled server, its matching core and knowledge bundle, production dependencies and a verified Node.js runtime. End users do not need Git, pnpm, a source checkout or a separate Node.js installation.

1. Run `BonniePDFMCPSetup-<version>-x64.exe`. It installs for the current user without administrator rights.
2. Select Codex, Claude Code, Claude Desktop, Antigravity, ZCode or GitHub Copilot (VS Code, Visual Studio or CLI) on the connection page. Existing unrelated servers and client settings are preserved. Replacing an existing BonniePDF entry requires selecting the replacement option; configuration backups are saved beside the original file.
3. Restart or reconnect the selected client and approve the server if the client requests it.
4. Ask the assistant to find an editable invoice and create a PDF.

Start-menu shortcuts **Connect assistants** and **Test connection** let you configure another client or diagnose the installation later. Client registration is separate from the client's own trust/approval flow.

For terminal use, open the installation directory and run:

```powershell
.\bonniepdf-mcp.cmd setup --client codex
.\bonniepdf-mcp.cmd doctor --client codex
.\bonniepdf-mcp.cmd setup --client claude-code --scope project --project-dir C:/Projects/MyApp
.\bonniepdf-mcp.cmd config --client antigravity
.\bonniepdf-mcp.cmd remove --client codex
```

`setup` with no client opens an interactive selector. Supported IDs are `codex`, `claude-code`, `claude-desktop`, `antigravity`, `vscode`, `visual-studio`, `copilot-cli` and `zcode`; `--client all` configures all eight targets. Claude Desktop uses user scope. `--config-file` selects an explicit client file, including an Antigravity installation with multiple configuration locations. `--replace` replaces only the existing BonniePDF entry after creating a backup.

The doctor checks the bundled runtime, MCP handshake, knowledge integrity, validation, native PNG previews, PDF generation and JSON export. With `--client`, it also reports whether that client's launch configuration matches the installation. It does not claim the assistant has approved or connected to the server.

Connections use separate persistent session and artifact directories beneath `%LOCALAPPDATA%/BonniePDF/MCP/clients/`. Project and user connections have distinct locations. Uninstall removes unchanged connections owned by this installation, preserving other servers, user-edited entries, generated files, sessions and backups. `BONNIEPDF_MCP_HOME` overrides the data root. Library licence declarations continue to use `BONNIEPDF_LICENSE` or `--license`; the installer does not grant library usage rights.

## GitHub Copilot setup

The installer has separate checkboxes for **VS Code**, **Visual Studio** and **Copilot CLI**. Registration preserves unrelated settings and follows the same backup and removal rules as other clients. You can also run:

```powershell
.\bonniepdf-mcp.cmd setup --client vscode
.\bonniepdf-mcp.cmd setup --client visual-studio
.\bonniepdf-mcp.cmd setup --client copilot-cli
.\bonniepdf-mcp.cmd doctor --client vscode
```

| Target        | User configuration                                                    | Project configuration              | Server object |
| ------------- | --------------------------------------------------------------------- | ---------------------------------- | ------------- |
| VS Code       | `%APPDATA%/Code/User/mcp.json` on Windows                             | `.vscode/mcp.json`                 | `servers`     |
| Visual Studio | `~/.mcp.json`                                                         | `.mcp.json` in the solution folder | `servers`     |
| Copilot CLI   | `$COPILOT_HOME/mcp-config.json`, default `~/.copilot/mcp-config.json` | `.mcp.json`                        | `mcpServers`  |

VS Code setup targets its default local profile. Use `--config-file` for another profile, portable installation or Insiders. For project setup add `--scope project --project-dir <folder>`. Claude Code and Copilot CLI can share the same project configuration slot: setup requires `--replace` if their BonniePDF entries differ. Visual Studio uses a separate `servers` object.

Restart/reconnect the selected client, select its agent mode and enable BonniePDF tools as needed. Client trust, account requirements and organizational policies are separate from configuration registration. A Windows local server is not automatically available in a cloud, SSH, WSL or container environment. Configuration tests do not certify every client/model combination.

Configuration references: [VS Code](https://code.visualstudio.com/docs/agents/reference/mcp-configuration), [Visual Studio](https://learn.microsoft.com/en-us/visualstudio/ide/mcp-servers), [Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers).

Automated tests cover these configuration formats, backups and removal. Interactive authoring in each Copilot application needs a separate client check; configuration tests alone do not establish that compatibility.

## ZCode setup

The installer has a **ZCode** checkbox, and the terminal command is the same as other clients:

```powershell
.\bonniepdf-mcp.cmd setup --client zcode
.\bonniepdf-mcp.cmd doctor --client zcode
```

| Scope   | Configuration                  | Server object |
| ------- | ------------------------------ | ------------- |
| User    | `~/.zcode/cli/config.json`     | `mcp.servers` |
| Project | `<project>/.zcode/config.json` | `mcp.servers` |

ZCode nests its server entries under `mcp.servers` rather than a single top-level key, and both scopes connect automatically at session start. Registration preserves unrelated settings and follows the same backup and removal rules as other clients.

## Ollama and smaller-model benchmarks

The installer includes an Ollama agent bridge and benchmark runner. Install Ollama separately, then choose an already installed model that supports tool calling. No model is selected or downloaded by the benchmark command.

```powershell
.\bonniepdf-mcp.cmd benchmark --list-models
.\bonniepdf-mcp.cmd benchmark --model "your-installed-model" --brief template-preview-pdf --profile lite --profile full --repeat 3
.\bonniepdf-mcp.cmd ollama --model "your-installed-model"
```

From a source checkout, use `pnpm eval` and `pnpm ollama` with the same options. `--host` chooses another Ollama endpoint. Context size, maximum output tokens, request deadlines and request limits are configurable; run `benchmark --help`. Thinking is disabled when the model supports disabling it; the runner sends previews automatically only to vision-capable models.

Use `ollama --profile full` when you need JSON, C# or TypeScript exports. The default `lite` profile exposes seven tools for document generation and edits. If a thinking model exhausts its output budget before requesting a tool, the runner stops with an explanation; use a non-thinking variant or raise `--max-output`.

Reports under `%LOCALAPPDATA%/BonniePDF/MCP/benchmarks/` include model digests and quantization, cumulative prompt/output tokens, model and tool timings, errors, saved artifacts and structural task checks. Each run uses a fresh persistent session; a separate full-profile inspector scores it without giving extra tools to a lite-profile model. JSON traces are saved beside each run.

Unavailable or partial token accounting is marked explicitly and excluded from token averages. Ollama-unavailable reports contain no model runs. Token totals measure Ollama-reported evaluation across requests, including repeated context; they are not unique conversation tokens or a cloud-provider bill. Structural success does not certify visual quality or image reconstruction. The fixture-provider tests validate the harness, not a model's capability. `BONNIEPDF_MCP_HOME` overrides the data root. Interactive transcripts are saved only with `--transcript`.

## Efficient generation

Use `create_document` with `output: "preview"`, `"pdf"` or `"pdf-and-preview"` when the starting document is ready to render. This accepts either `exampleId` or a complete `definition`. A template clone, PNG preview and PDF export can now be requested in one tool call:

```json
{ "exampleId": "business-invoice", "output": "pdf-and-preview" }
```

For documents needing edits, omit `output`, locate fields with `find_elements`, and batch related changes in `patch_and_preview`. Creation returns eight outline elements by default; `outlineLimit` accepts 0–25. The entire document remains editable. If immediate rendering fails after creation, the error includes the saved handle and revision so the assistant can fix that document rather than recreate it.

Fetch related element descriptions together, for example `describe_element({"names":["TextBlock","Container","Table"]})`. Up to eight names are accepted. Use a single `name` with `property` for a focused property schema. Both improvements are available in the `full` and seven-tool `lite` profiles.

For local diagnostics, add `--metrics-file C:/Logs/bonniepdf-metrics.jsonl` to the server launch arguments. Each tool call records elapsed server time, input bytes, response text and structured bytes, image bytes and error status. This is opt-in; it records no argument values, document contents, image data or model tokens. Logs accumulate until the host removes or rotates them. Server time excludes model thinking and client processing.

Run `pnpm benchmark:efficiency` after building to compare separate and combined invoice generation over the actual stdio protocol. Results are saved in `out/efficiency/report.json`. Character counts and image bytes are not token counts; use model-reported usage and output-quality checks to compare models.

## Build a Windows release

From the workspace root, after building core:

```powershell
pnpm --filter @bonniepdf/mcp package:windows
pnpm --filter @bonniepdf/mcp test:installer
```

Packaging regenerates the knowledge bundle and compiles the server before staging. It requires Windows x64, Node.js 24+ with pnpm, and Inno Setup 6.3+. Set `ISCC_PATH` if the compiler is outside the standard locations. Production dependencies are installed in an isolated staging workspace, never deployed over the development workspace. The Node executable is checked against its upstream SHA-256, and its complete licence is included.

The build produces `out/releases/<unique-build>/BonniePDFMCPSetup-<version>-x64.exe`, a portable payload, a dependency lock and a release manifest with hashes. `out/releases/latest.json` identifies the latest successful build. Builds are unsigned; apply the release signing process before public distribution. The Inno AppId is stable across upgrades and must not change.

`test:installer` installs outside the source tree, tests four disposable client configurations with global Node removed from PATH, repairs the installation and uninstalls it. It refuses to run if a real BonniePDF MCP installation is already registered. Reports remain in `out/installer-test-latest.json` and the returned temporary test directory.

## Build and verify

Run from the estate root:

```powershell
pnpm install
pnpm mcp:build
pnpm mcp:test
pnpm --filter @bonniepdf/mcp check:knowledge
```

Node 24 or later is required. `mcp:build` builds core, regenerates the knowledge bundle and compiles the server. PNG previews use the included resvg dependency. Neither PDF generation nor PNG preview generation requires Chromium.

The generated `data/` bundle is ignored by Git. Example sources stay in the shared catalogue; the MCP repository keeps the generator and server code. `build` generates the bundle before compiling, and `pnpm pack` runs that build through `prepack`. Packages and Windows installers include the complete bundle, so end users need no source checkout. `build:code` compiles only the server for development; it does not create a runnable distribution by itself.

The bundle contains catalogue metadata, original TypeScript and corresponding C# source where available, verified JSON definitions, public generated API reference pages, the published schema and deduplicated resources. Runtime uses this bundle and the installed core package; it does not read sibling repositories. Building from source requires the workspace's library/example sources, matching C# examples, generated public API reference pages and published schema. Regenerate public API documentation through its normal pipeline before refreshing knowledge after an API change.

Generation never drops unrepresentable content. Callback templates and other unsupported constructs make an example **source-only**, with the reason available through `get_example`. Password-removal notes and content that changes between repeated generation also make an example source-only. For example, a report of measured runtime timings should be produced by running its original source. A JSON starting point must pass strict validation, a canonical round trip, repeatable generation, PDF generation, and first-page SVG comparison against the source example. This is not external PDF conformance certification or a comparison of every rendered page.

`check:knowledge` rebuilds in memory and checks for differences and stale files. `manifest.json` records file hashes, verified on server startup. The bundle also records its core version, definition version and content hash. Generation pins the example clock to 1 January 2026 at 12:00 UTC so time-dependent sample content is reproducible. These are illustrative starting points: replace sample dates, amounts and identities for your actual document. The server and rendering workers use the real clock.

## Connect Codex

From the estate root, register the compiled server:

```powershell
codex mcp add bonniepdf -- node C:/GITHUB/bonniepdf/BonniePDF-MCP/dist/index.js
codex mcp get bonniepdf
```

Use the correct absolute path if the estate is elsewhere. Restart/reopen the client as necessary to discover the connection. The equivalent configuration is in `config/codex.toml.example`; merge that table into your existing configuration.

## Connect Claude Code

```powershell
claude mcp add --transport stdio --scope user bonniepdf -- node C:/GITHUB/bonniepdf/BonniePDF-MCP/dist/index.js
claude mcp get bonniepdf
```

`config/claude.json.example` also supplies the standard `mcpServers` entry for clients using JSON configuration. Merge it with existing entries. A browser-hosted assistant needs a reachable remote transport; this implementation is local stdio.

## First request

> Use the BonniePDF MCP to find a verified invoice example. Clone it, change its title to “October Services”, inspect the first-page preview, validate it and save the PDF and reusable definition. Use document handles and small patches rather than copying the complete example into the conversation.

Handles and revisions last for one server connection unless `--session-dir` enables persistence. Installed client connections enable persistence by default. Export definitions to retain a portable copy. A source launch saves artifacts under this package's `out/` by default, with unique directories so existing files are not overwritten.

## Tools

| Tool                  | Use                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `get_capabilities`    | Versions, counts, element list and workflow guidance                                                         |
| `search_docs`         | Bounded example/API summaries; filter by language or editable examples                                       |
| `get_doc`             | Read one public reference page in bounded sections                                                           |
| `describe_element`    | Wire-format keys, tokens and value types; optional `property` returns a focused JSON schema with constraints |
| `get_example`         | Metadata or selected JSON/TypeScript/C# source sections                                                      |
| `create_document`     | Clone an example by ID or accept a new definition                                                            |
| `list_documents`      | List open document handles and revisions                                                                     |
| `find_elements`       | Find edit paths by element text, type or ID                                                                  |
| `get_document`        | Read a subtree using an RFC 6901 JSON Pointer                                                                |
| `patch_document`      | Atomic add/remove/replace operations with revision checking                                                  |
| `patch_and_preview`   | Apply an edit and preview the resulting document                                                             |
| `delete_document`     | Release a session handle                                                                                     |
| `validate_definition` | Strict shape and semantic validation with precise errors                                                     |
| `preview_definition`  | Page count, up to three selected pages, layout and advisory findings                                         |
| `render_pdf`          | PDF artifact/resource link and generation diagnostics                                                        |
| `export_definition`   | Save JSON or native TypeScript/C# source, embedding bundle resources                                         |

`bonniepdf://guide` and `bonniepdf://schema/definition/1.0` are readable MCP resources. Artifacts produced in the current connection can also be read through their returned resource URIs. Large artifacts should be opened via their local paths. `author-document` is a reusable MCP prompt.

For a new layout, inspect the accepted values before authoring: `describe_element({name: "Page", property: "size"})` returns lowercase named sizes such as `"a4"` and the custom size shape. `describe_element({name: "HorizontalStack", property: "children"})` explains both plain elements and weighted children. `describe_element({name: "Container", property: "padding"})` returns the supported spacing forms and length units. These focused responses use the bundled published schema; semantic validation remains authoritative. Omit `property` for the usual key summary, or request a value type directly with `name: "Length"`.

`create_document` assigns missing IDs to elements. Use the returned outline and `get_document` to locate an edit. Layout snapshots carry these IDs in `sourceId` for body content; page chrome is not captured in that tree. Array edits use standard JSON Pointer indices; `-` appends on an add operation. Move, copy and test operations are supported; root replacement is not supported. Invalid edits leave the document and revision unchanged.

## Native source export

`export_definition` accepts `format: "json"` (the existing default), `"typescript"`, `"dotnet"` or `"all"`. For example:

```json
{ "documentId": "<returned document ID>", "format": "all" }
```

The response contains file paths and resource links. JSON remains a portable definition; `document.ts` and `Program.cs` use native BonniePDF constructors, properties and collection methods. They do not load or interpret JSON. Edits, page chrome, tables, charts, metadata and embedded resources are carried into the generated code. Resources are embedded as base64 byte arrays so the program does not depend on the MCP knowledge bundle. Exporting source never compiles or executes code inside the server.

For TypeScript, install `@bonniepdf/core`, compile the ES module with TypeScript (`moduleResolution: "bundler"`), then run it in Node.js. For C#, create a .NET 8+ console project, add `BonniePDF`, and replace `Program.cs`. Both programs save `document.pdf` and declare Evaluation; select the licence tier applicable to your application.

Native exports explicitly reject encryption settings without host credentials, catalogue font path aliases, and explicit first-page margins (the native page margin is read-only). Use JSON export for those definitions. Embedded document font resources selected by family are supported. An unsupported native export writes no files and leaves the session unchanged; an `all` request prepares every format before saving any.

`pnpm verify:native --all` compiles and renders native exports from the editable catalogue and compares round-trip definitions in each runtime. Export API metadata is generated from the public .NET assembly with `node scripts/generate-dotnet-api.mjs`; pass an assembly path to select another build, or `--check` to detect drift. Rebuild the library before checking metadata.

## Resource and rendering options

```powershell
node BonniePDF-MCP/dist/index.js --out-dir C:/GITHUB/bonniepdf/BonniePDF-MCP/out --resource-dir C:/GITHUB/bonniepdf/my-assets --license evaluation --timeout-ms 45000
```

The default licence declaration is `evaluation`; `--license` or `BONNIEPDF_LICENSE` supplies another declaration. This declares the host's applicable tier through the existing library mechanism; it does not grant usage rights or enforce entitlements. Governing library licences remain unchanged.

Bundle resources resolve by hash. Other references require an explicit resource directory and resolve to files within it, checked after symlink resolution. There is no arbitrary URL resolver, submitted source execution or password tool. Portable export currently embeds bundle resources only; host-supplied references must be managed by the host.

Rendering runs in one worker at a time with a 256 MB JavaScript heap limit and configurable deadline; cancellation terminates that worker. Input is capped at 2 MB, 5,000 elements and 100 rendered pages. There are at most 50 live documents and 32 MB of stored JSON per connection. PNG generation has per-page timeouts and a maximum size of 2,000 × 3,000 pixels. Rasterisation uses resvg without a browser; external SVG references are stripped and system fonts are not consulted. The worker heap limit is not an operating-system sandbox or a bound on total native memory.

## Token economy and validation

Clone by example ID, retrieve summaries before source, patch only changed fields and use `includeImages: false` when a visual review is unnecessary. Tool descriptions, retrieved content and preview images still consume assistant context.

`scripts/smoke.mjs` tests the actual stdio protocol: discovery, resource reading, example retrieval, invoice cloning/editing, validation, PNG/layout preview, PDF artifact reading, definition export and error handling. It writes `out/smoke-report.json` with output paths and tool text character counts. These are diagnostic counts, not measured token savings. Compare model usage for accepted documents in your clients before claiming a reduction.

The server generates JSON, native TypeScript/C# source and PDF artifacts. Native source exports reflect the current edited document. They do not register new examples in the catalogue or certify PDF/A/PDF/UA conformance.

## Findings from the initial implementation

The following is a snapshot of the generated bundle and verification on **5 October 2026**, using core **2026.7.2** and Document Definition **1.0**. `get_capabilities` and `data/knowledge.json` give the current counts and per-example export results after regeneration.

### Existing example coverage

The bundle contains **94 distinct examples**, of which **37** passed the checks for an editable JSON starting point and **57** remain source-only. Authoring-style variants are excluded from this count so the same document is not counted twice. TypeScript source is available for all 94; corresponding C# source was found for 92. The two without C# source in this snapshot are `first-pdf` and `multi-column-layouts`.

| Reason for source-only status                             | Examples | Representative cases                                                                                          |
| --------------------------------------------------------- | -------: | ------------------------------------------------------------------------------------------------------------- |
| Hand-written header/footer callbacks                      |       50 | `bar-chart`, `tables`, `headers-footers`, `audit-report`, `annual-report`                                     |
| Page-background callbacks without a header/footer blocker |        4 | `event-ticket`, `annual-report-geometric-cover`, `annual-report-gradient-cover`, `annual-report-masked-cover` |
| Custom canvas drawing callbacks                           |        2 | `course-certificate`, `utility-bill`                                                                          |
| Password omission reported by the definition writer       |        1 | `encryption`                                                                                                  |

These rows are mutually exclusive. The main `annual-report` example also has an unrepresentable page-background callback, but is counted in the header/footer row.

The largest blocker is **how the example authors its page chrome**, rather than its main content. For instance, `bar-chart` fails export at `/settings/footerTemplate`; its chart is not the reported blocker. The same distinction applies to many table, report and industry examples. A source-only result is not evidence that the library cannot generate that PDF, or that its chart/table element is unavailable in JSON.

JSON cannot store arbitrary executable functions. The writer can export templates created from declarative elements, but cannot recover the intent of a hand-written callback. The certificate draws its frame and seal through `CanvasElement`; the utility bill uses a canvas callback for its dashed cut line. Those drawing instructions likewise have no faithful Definition 1.0 representation.

The encryption example is handled separately: the writer reports `secret-omitted` at `/settings/encryption` because passwords belong to the host, not the stored definition. The current MCP has no password-supply interface, so it does not offer that example as an equivalent editable clone. This is not a limitation of the core encryption implementation.

Source-only examples remain searchable, and `get_example` can retrieve their original source and the export reason. `create_document(exampleId)` rejects them explicitly. Use `search_docs` with `kind: "examples"` and `editableOnly: true` to find a cloneable design. The server never removes a footer, background, drawing or security setting just to make export succeed.

### Increasing editable coverage

The first candidates are the examples blocked only by page chrome. Where the behaviour fits, author templates with TypeScript `pageTemplate(...)` and C# `PageTemplate.FromElements(...)`, preserving the existing design. The existing declarative selection supports default, first-page, odd-page and even-page elements. Page-number text can use `{{CurrentPage}}` and `{{TotalPages}}` instead of constructing a different string in a callback.

Conversion needs review: a callback may branch on other page numbers or build state that those selectors cannot express. Replacing canvas artwork with supported elements or an SVG asset also requires a visual equivalence check. Keep the source example when a faithful replacement is unavailable.

Such example changes belong in the shared example catalogue and corresponding .NET examples, with authoring-style companions kept equivalent. Re-run the existing example/equivalence checks and regenerate the MCP bundle. Extending the document format itself would instead require a shared specification, fixtures and both core implementations; the MCP should not invent its own incompatible representation.

### Verification and operational findings

- **The complete local workflow works:** the stdio smoke test discovers tools and resources, clones and edits an invoice, reads the edit back, validates it, renders a PNG/layout preview, writes and reads its PDF artifact, and exports reusable JSON. It also exports an image-bearing definition with its resources embedded and validates that export.
- **Verification has defined limits:** automated tests cover atomic edits, stale revisions, resource-directory boundaries, deadlines, cancellation, client configuration, native exports and the Ollama bridge. Catalogue verification compares the first-page SVG with the original and checks a canonical JSON round trip; it does not prove every page matches, compare cross-language PDF bytes, or replace external conformance validation.
- **Codex configuration is registered locally:** the configuration was checked and the server was exercised through an MCP client. This is not a measured model-driven authoring benchmark. Claude Code setup is documented, but its CLI was not installed on the implementation machine, so that client was not tested directly.
- **Time-dependent examples need a reproducible build clock:** the receipt includes the current time. Without pinning it, an unchanged catalogue failed the knowledge drift check on successive builds. The generator now fixes its clock and timezone; runtime rendering uses the real clock. Replace illustrative dates when adapting a clone.
- **Serialisation checks run before rendering:** rendering can normalise document state. The generator checks the canonical round trip before PDF/SVG generation, then checks rendered output separately. Comparing those different stages initially caused false source-only classifications.
- **Documentation freshness needs the normal generation pipeline:** the MCP consumes generated public API reference pages. Bundle hashes detect file changes and the installed core version is checked at startup, but neither proves that a page's prose accurately describes an API change. Regenerate the public reference first, then regenerate/check MCP knowledge.
- **Measure tokens with the intended model:** the smoke report records text character counts. The Ollama benchmark records actual model-reported tokens and structural success. Those measurements do not establish image reconstruction quality or token savings in another provider's client.

The package is licensed under the [Apache-2.0](LICENSE) license.

### Native transforms

Use `Flip` with `horizontal` and/or `vertical` to mirror a native subtree inside its original box. Use `Translate` with signed `x` / `y` lengths to move painted content: positive x moves right, positive y moves down. Both retain flow dimensions and accept optional positive `contentWidth`. Provide space for translated content. They compose with `Rotate`, preserve native PDF/SVG content, and transform links and layout snapshots. All three wrappers are atomic and reject page breaks.

Use `Rotate` for sideways labels and angled native content. `angle` is clockwise degrees; `mode: "constrained"` accepts quarter turns and swaps layout dimensions, while `mode: "free"` retains the original flow box. Set `contentWidth` to control the child width before rotation. Rotation keeps the subtree on one page and rejects page breaks. `describe_element({ name: "Rotate" })` exposes the accepted JSON keys; previews and PDFs preserve native text and transformed link bounds.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the full license text.
