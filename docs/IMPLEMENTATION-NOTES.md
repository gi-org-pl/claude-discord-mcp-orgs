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

## feat/roles-and-guild-rules

- Gate logic moved out of `server.ts` into `lib/access.ts` (`evaluateGate`)
  so it can be tested without discord.js. Behaviour for DMs, pairing and
  per-channel entries is unchanged except for the role check at the end.
- New keys: `members` (global roles), `owners` (flag), `guilds` (per-user
  guild grants). Role resolution: channel `roles` override > guild grant >
  global role > none.
- Default deny decision: a sender without a role is **dropped**, not
  delivered with a note. Reason: delivery already places their text in the
  session context. They get one short reply per 24 h (in-memory rate limit,
  resets on restart) unless `noRoleNotice` is false.
- Outbound tools may target any channel of a guild that has a guild rule,
  mirroring the inbound side.
- `test/fakes.ts` mocks discord.js and the MCP SDK with `mock.module`, so
  `server.ts` is imported for real in `test/server.test.ts`.
