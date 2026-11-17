# BonniePDF MCP

A local MCP server for creating, inspecting and refining BonniePDF JSON documents from Claude Code, Codex and other MCP clients. It retrieves existing examples and generated API documentation, validates definitions through the library, previews selected pages and writes PDF artifacts.

The assistant writes the content and edits. BonniePDF measures, paginates and renders it. This server does not need an AI API key or a hosted service.

## Build and verify

Run from the estate root:

```powershell
pnpm install
pnpm mcp:build
pnpm --filter @bonniepdf/mcp exec playwright install chromium
pnpm mcp:test
pnpm --filter @bonniepdf/mcp check:knowledge
```

Node 24 or later is required. `mcp:build` builds core, regenerates the knowledge bundle and compiles the server. Chromium is used only to turn BonniePDF's SVG previews into PNGs with their embedded fonts. PDF generation runs in BonniePDF, without a browser. Without Chromium, SVG/layout artifacts remain available and previews return a PNG warning.

The generated bundle contains catalogue metadata, original TypeScript and corresponding C# source where available, verified JSON definitions, public generated API reference pages, the published schema and deduplicated resources. Runtime uses this bundle and the installed core package; it does not read sibling repositories. Bundle generation uses the estate's existing source locations. Regenerate public API documentation through its normal pipeline before refreshing knowledge after an API change.

Generation never drops unrepresentable content. Callback templates and other unsupported constructs make an example **source-only**, with the reason available through `get_example`. Password-removal notes also make an example source-only. A JSON starting point must pass strict validation, a canonical round trip, PDF generation, and first-page SVG comparison against the source example. This is not external PDF conformance certification or a comparison of every rendered page.

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

Handles and revisions last for one server connection. Export definitions before restarting if you want to retain edits. Artifacts are saved under this package's `out/` by default, with unique directories so existing files are not overwritten. They remain on disk after the server exits.

## Tools

| Tool | Use |
| --- | --- |
| `get_capabilities` | Versions, counts, element list and workflow guidance |
| `search_docs` | Bounded example/API summaries; filter by language or editable examples |
| `get_doc` | Read one public reference page in bounded sections |
| `describe_element` | Wire-format keys, tokens and value types; optional `property` returns a focused JSON schema with constraints |
| `get_example` | Metadata or selected JSON/TypeScript/C# source sections |
| `create_document` | Clone an example by ID or accept a new definition |
| `get_document` | Read a subtree using an RFC 6901 JSON Pointer |
| `patch_document` | Atomic add/remove/replace operations with revision checking |
| `delete_document` | Release a session handle |
| `validate_definition` | Strict shape and semantic validation with precise errors |
| `preview_definition` | Page count, up to three selected pages, layout and advisory findings |
| `render_pdf` | PDF artifact/resource link and generation diagnostics |
| `export_definition` | Save JSON, embedding external resources from the knowledge bundle |

`bonniepdf://guide` and `bonniepdf://schema/definition/1.0` are readable MCP resources. Artifacts produced in the current connection can also be read through their returned resource URIs. Large artifacts should be opened via their local paths. `author-document` is a reusable MCP prompt.

For a new layout, inspect the accepted values before authoring: `describe_element({name: "Page", property: "size"})` returns lowercase named sizes such as `"a4"` and the custom size shape. `describe_element({name: "HorizontalStack", property: "children"})` explains both plain elements and weighted children. `describe_element({name: "Container", property: "padding"})` returns the supported spacing forms and length units. These focused responses use the bundled published schema; semantic validation remains authoritative. Omit `property` for the usual key summary, or request a value type directly with `name: "Length"`.

`create_document` assigns missing IDs to elements. Use the returned outline and `get_document` to locate an edit. Layout snapshots carry these IDs in `sourceId` for body content; page chrome is not captured in that tree. Array edits use standard JSON Pointer indices; `-` appends on an add operation. Move, copy and test operations are supported; root replacement is not supported. Invalid edits leave the document and revision unchanged.

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

The server generates JSON/PDF artifacts. It can retrieve existing idiomatic TypeScript/C# examples but does not generate idiomatic source from arbitrary definitions, register new examples in the shared catalogue, or independently certify PDF/A/PDF/UA conformance. Those are separate workflows.

## Findings from the initial implementation

The following is a snapshot of the generated bundle and verification on **5 October 2026**, using core **2026.7.2** and Document Definition **1.0**. `get_capabilities` and `data/knowledge.json` give the current counts and per-example export results after regeneration.

### Existing example coverage

The bundle contains **94 distinct examples**, of which **37** passed the checks for an editable JSON starting point and **57** remain source-only. Authoring-style variants are excluded from this count so the same document is not counted twice. TypeScript source is available for all 94; corresponding C# source was found for 92. The two without C# source in this snapshot are `first-pdf` and `multi-column-layouts`.

| Reason for source-only status | Examples | Representative cases |
| --- | ---: | --- |
| Hand-written header/footer callbacks | 50 | `bar-chart`, `tables`, `headers-footers`, `audit-report`, `annual-report` |
| Page-background callbacks without a header/footer blocker | 4 | `event-ticket`, `annual-report-geometric-cover`, `annual-report-gradient-cover`, `annual-report-masked-cover` |
| Custom canvas drawing callbacks | 2 | `course-certificate`, `utility-bill` |
| Password omission reported by the definition writer | 1 | `encryption` |

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
- **Verification has defined limits:** all 12 automated tests pass, including atomic edits, stale revisions, resource-directory boundaries, deadlines and cancellation. Catalogue verification compares the first-page SVG with the original and checks a canonical JSON round trip; it does not prove every page matches, compare cross-language PDF bytes, or replace external conformance validation. The invoice PNG was also inspected visually.
- **Codex configuration is registered locally:** the configuration was checked and the server was exercised through an MCP client. This is not a measured model-driven authoring benchmark. Claude Code setup is documented, but its CLI was not installed on the implementation machine, so that client was not tested directly.
- **Time-dependent examples need a reproducible build clock:** the receipt includes the current time. Without pinning it, an unchanged catalogue failed the knowledge drift check on successive builds. The generator now fixes its clock and timezone; runtime rendering uses the real clock. Replace illustrative dates when adapting a clone.
- **Serialisation checks run before rendering:** rendering can normalise document state. The generator checks the canonical round trip before PDF/SVG generation, then checks rendered output separately. Comparing those different stages initially caused false source-only classifications.
- **Documentation freshness needs the normal generation pipeline:** the MCP consumes 652 already-generated public API reference pages. Bundle hashes detect file changes and the installed core version is checked at startup, but neither proves that a page's prose accurately describes an API change. Regenerate the public reference first, then regenerate/check MCP knowledge.
- **Token savings are still unmeasured:** cloning by ID and returning a short patch acknowledgement avoid retransmitting complete definitions. The smoke report records text character counts, not model tokens, reasoning usage or image costs. A fair benchmark must compare accepted documents of equivalent quality in the intended client.

The package is licensed under the [Apache-2.0](LICENSE) license.

### Native transforms

Use `Flip` with `horizontal` and/or `vertical` to mirror a native subtree inside its original box. Use `Translate` with signed `x` / `y` lengths to move painted content: positive x moves right, positive y moves down. Both retain flow dimensions and accept optional positive `contentWidth`. Provide space for translated content. They compose with `Rotate`, preserve native PDF/SVG content, and transform links and layout snapshots. All three wrappers are atomic and reject page breaks.

Use `Rotate` for sideways labels and angled native content. `angle` is clockwise degrees; `mode: "constrained"` accepts quarter turns and swaps layout dimensions, while `mode: "free"` retains the original flow box. Set `contentWidth` to control the child width before rotation. Rotation keeps the subtree on one page and rejects page breaks. `describe_element({ name: "Rotate" })` exposes the accepted JSON keys; previews and PDFs preserve native text and transformed link bounds.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the full license text.

