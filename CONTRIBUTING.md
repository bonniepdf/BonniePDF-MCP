# Contributing to the BonniePDF MCP server

Thanks for your interest. This file covers two things: the legal basis on which
contributions are accepted, and the practical steps for getting a change in.

## Before you open a pull request

Open an issue first for anything beyond a typo or an obvious bug fix. The
server exposes the BonniePDF document model to AI assistants, so a change to a
tool's inputs or outputs can break clients you cannot see. Agreeing the
approach in an issue saves rework.

Changes to how documents are laid out or rendered belong in the BonniePDF
library, not in this server.

## Licensing of contributions

This repository is published under the **Apache-2.0 License** (see
[LICENSE](LICENSE)), and contributions are accepted under the same terms. The
grant below records provenance and ensures clarity, as this server ships
alongside commercially licensed BonniePDF distributions.

By submitting a contribution you confirm that:

1. You wrote the contribution yourself, or you have the right to submit it under
   the terms below — including any clearance you need from an employer or client.
2. You grant CodeFocus Limited a perpetual, worldwide, non-exclusive,
   royalty-free, irrevocable licence to use, reproduce, modify, prepare
   derivative works of, publicly display, sublicense, and distribute your
   contribution and such derivative works, **including as part of commercially
   licensed distributions of BonniePDF under different licence terms**.
3. You understand that you retain copyright in your contribution, and that this
   grant does not transfer ownership of it.
4. Your contribution is provided without warranty of any kind.

## Signing off your commits

We use the [Developer Certificate of Origin](https://developercertificate.org/)
rather than a separate contributor licence agreement. Add a sign-off line to
each commit:

```
Signed-off-by: Your Name <your.email@example.com>
```

`git commit -s` adds it for you. Use your real name and an email address you
can be reached at. A pull request whose commits are not signed off cannot be
merged.

## Security issues

Do not open a public issue or pull request for a suspected vulnerability. See
[SECURITY.md](SECURITY.md).

## Building and testing

The server builds against the TypeScript library in a sibling checkout. Set up
the workspace as described under **Build and verify** in the
[README](README.md), then run from the parent directory:

```sh
pnpm --filter @bonniepdf/mcp typecheck
pnpm --filter @bonniepdf/mcp test
pnpm --filter @bonniepdf/mcp smoke
pnpm --filter @bonniepdf/mcp check:knowledge
```

## Rules for server code

- stdout belongs to MCP. Log to stderr.
- Render untrusted definitions in bounded workers. Never evaluate source code
  submitted by a tool caller.
- Definitions never grant filesystem or network access. Resource paths come
  only from the host's configuration.
- Document edits must be atomic and revision-checked.
- The generated `data/` bundle stays out of source control.

## Code of conduct

Be civil and assume good faith. Discussion stays on the technical merits of the
change. CodeFocus Limited may decline or revert a contribution, or restrict
participation, at its discretion.

## Questions

Open an issue, or email support@bonniepdf.dev.
