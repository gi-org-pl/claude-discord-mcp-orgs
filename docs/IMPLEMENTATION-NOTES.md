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

## feat/policy-engine

- Policy is data: `roles` and `categories` are open maps. A new role or a
  new connector is a JSON edit; a new shell program needs an analyser in
  code (`lib/shell.ts`), because a command line cannot be judged by name.
- Category decisions: `allow`, `deny`, `owner`, `worktree`, `allowlist`.
  Categories match tool names by glob, first match in file order wins, so
  `figma-bridge-destructive` sits above `figma-bridge`.
- Shell analyser denies anything it cannot reduce to plain argument lists:
  `$(...)`, backticks, subshells, here-docs, redirection to files, env
  assignments, a variable as program name. Unknown git subcommands are
  denied because aliases can run arbitrary commands.
- Force-push/delete is checked against `sharedBranches`; with no refspec the
  current branch is read from `.git/HEAD` (worktree `gitdir:` files are
  followed) without spawning git.
- "Isolated worktree" = path under `worktreeRoots` (default
  `**/.claude/worktrees/*`, `**/.worktrees/*`). Installs/tests also require
  that no secret-looking variable is in the environment the hook sees (the
  same environment the Bash tool inherits) and no `.env` file at the
  worktree top. This is a path rule, not a sandbox (see README limits).
- Guards for every role, board and owner included: no writes to settings,
  plugin and channel-state files; shell commands mentioning them are denied.
- Unknown role names resolve to `none` (lowest tier).
