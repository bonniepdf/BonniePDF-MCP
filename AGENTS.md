# BonniePDF MCP

This package exposes the existing BonniePDF document model through local MCP tools. Keep core behaviour in the library; the server handles retrieval, document sessions, resource resolution and artifacts.

Use pnpm from the estate root. Build core before this package. Generate the knowledge bundle from the example catalogue and public generated documentation, then run typecheck, tests and the protocol smoke test. Never copy private strategic or specification prose into the bundle.

`data/` is generated build output and must stay out of source control. The normal build and package lifecycle regenerate it; distributions include it. Use `build:code` only for compilation without bundle generation.

stdout belongs to MCP. Log to stderr. Render untrusted definitions in bounded workers. Do not evaluate source submitted by a tool caller. Resource paths are host-configured; definitions never grant filesystem or network access. Edits must be atomic and revision-checked.

The package is licensed under Apache-2.0. Do not publish or change the governing library licences.
