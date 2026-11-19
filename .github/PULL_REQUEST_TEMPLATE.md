## What does this PR do?

<!-- One or two sentences describing the change. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Refactor / internal improvement
- [ ] Documentation / tooling

## Checklist

- [ ] `pnpm --filter @bonniepdf/mcp typecheck` passes
- [ ] `pnpm --filter @bonniepdf/mcp test` passes
- [ ] `pnpm --filter @bonniepdf/mcp smoke` passes
- [ ] `pnpm --filter @bonniepdf/mcp check:knowledge` passes
- [ ] Document behaviour stays in `@bonniepdf/core`; the server only adds retrieval, sessions, resources and artifacts
- [ ] Nothing is written to stdout except MCP protocol messages
- [ ] Tool or profile changes are reflected in the README
- [ ] Every commit is signed off (`git commit -s`), as described in [CONTRIBUTING.md](../CONTRIBUTING.md)
