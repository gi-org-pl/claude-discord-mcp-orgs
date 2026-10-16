# Implementation notes

Short log of how this fork was built. Newest entries at the bottom.

## Baseline

- `main` starts with the upstream plugin 0.0.4 copied unchanged (no
  `node_modules`). Every change after that lives on its own branch, merged
  into `main` with `--no-ff`, so `git log --first-parent main` reads as a list
  of features.

## feat/state-and-audit

- `lib/state.ts`: one place that knows the state directory layout, shared by
  the server and the hook. Atomic JSON writes (tmp + rename).
- `lib/audit.ts`: JSONL audit log. Writes never throw; fields are clipped to
  500 characters so a long command cannot bloat the log.
- `package.json` renamed to `claude-discord-mcp-orgs`, `bun test` script.
