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

## feat/request-binding

- Request id = `dr_` + 16 random hex chars. It is a lookup key, not a
  secret the model can keep: the model sees every id in its context. Ids are
  scrubbed from outbound `reply`/`edit_message` so Discord users never see
  them (they cannot name someone else's request).
- `requests.json` is written only by the server (atomic rename); the hook
  only reads it. Records are kept `retentionDays` (30) so markers in
  long-running sub-agents and reminders still resolve; a request counts as
  *open* for `activeMinutes` (360) or until `end_request`.
- Limits come from the role in the policy (`limits.maxConcurrent`,
  `limits.dailyRequests`, UTC day). Over the limit: not delivered, one
  notice per hour per reason, audit line.
- Permission replies ("yes abcde") are intercepted before a request is
  created, so they do not count against limits.
- Policy file invalid: nothing is delivered (fail closed), error on stderr
  and in the audit log.

## feat/pretooluse-hook

- Hook input has `agent_id` only inside sub-agents (checked in the Claude
  Code 2.1.x hook schema). Sub-agent transcripts live at
  `<project>/<session_id>/subagents/agent-<agent_id>.jsonl`; the first user
  entry is the prompt written by the parent, where the marker must be.
- Prompts are told apart by `origin.kind` on transcript `user` entries:
  `channel`, `human`, `task-notification`, others. Only `human` counts as the
  operator. Unknown kinds (scheduled prompts etc.) are trusted only through
  a marker.
- Main thread on a Discord turn = lowest role among open requests. This is
  the price of one shared session: concurrent requests from different
  people can only get different roles in different sub-agents.
- Markers inside a Discord message body are ignored (only the tag's
  `request_id` attribute counts), so quoting someone else's marker does not
  lift a role.
- The transcript is scanned incrementally (byte offset cached per session in
  `hook-cache/`), so a long session costs only the new tail per call.
- The hook never outputs "allow"; it denies or stays silent. Errors deny.
- Hook uses `os.homedir()`, not `$HOME`: Git Bash on Windows sets
  `HOME=/c/Users/...`, which would not match native paths.

## feat/escalation

- File per escalation, written by the hook (create, consume) and the server
  (notified, decided). No shared mutable file, so no lock is needed.
- The approval is bound to (request id, sha256 of tool + input without
  `description`/`timeout`/`run_in_background`) and expires after one hour
  unused. One approval = one call.
- Approvers come from global roles only (`members`), not guild grants, so a
  guild-scoped grant cannot make someone an approver.
- The requester cannot approve their own escalation even if they are an
  approver (they would not have been denied as board anyway, but a
  role can be both `escalate` and `approvesEscalations` in a custom policy).
- The decision is fed back to the session as a channel notification with the
  original request id and role, so the model knows to retry or to tell the
  requester. Message text cannot fake an approval: the hook checks the file.
