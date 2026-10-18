![claude-discord-mcp-orgs header](https://raw.githubusercontent.com/gi-org-pl/claude-discord-mcp-orgs/main/.github/image/header.png)

# Discord channel for organisations (claude-discord-mcp-orgs)

A fork of the official Discord channel plugin for Claude Code (0.0.4) for
teams where several people may write to one assistant. On top of upstream it
adds:

- **roles per sender** (explicit user-id lists), an **owner** flag, and
  **default deny** for senders without a role;
- **guild-level grants** that also cover channels created later;
- **request binding**: every message becomes a request with its own id and
  role, which a **PreToolUse hook** uses to narrow every tool call, including
  tool calls of sub-agents and scheduled prompts;
- a **per-role policy** (connectors, shell allowlists for git/gh, isolated
  worktrees), **per-role limits**, a **JSONL audit log**;
- **escalation**: a denied call can be approved once by a board member with a
  Discord button;
- permission prompts relayed **only to the owner**.

The plugin keeps the name `discord`, so the commands stay `/discord:access`
and `/discord:configure`. See [NOTICE](./NOTICE) for the list of changes and
[docs/IMPLEMENTATION-NOTES.md](./docs/IMPLEMENTATION-NOTES.md) for the log.

---

Connect a Discord bot to your Claude Code with an MCP server.

When the bot receives a message, the MCP server forwards it to Claude and provides tools to reply, react, and edit messages.

## Prerequisites

- [Bun](https://bun.sh) — the MCP server runs on Bun. Install with `curl -fsSL https://bun.sh/install | bash`.

## Quick Setup
> Default pairing flow for a single-user DM bot. See [ACCESS.md](./ACCESS.md) for groups and multi-user setups.

**1. Create a Discord application and bot.**

Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Give it a name.

Navigate to **Bot** in the sidebar. Give your bot a username.

Scroll down to **Privileged Gateway Intents** and enable **Message Content Intent** — without this the bot receives messages with empty content.

**2. Generate a bot token.**

Still on the **Bot** page, scroll up to **Token** and press **Reset Token**. Copy the token — it's only shown once. Hold onto it for step 5.

**3. Invite the bot to a server.**

Discord won't let you DM a bot unless you share a server with it.

Navigate to **OAuth2** → **URL Generator**. Select the `bot` scope. Under **Bot Permissions**, enable:

- View Channels
- Send Messages
- Send Messages in Threads
- Read Message History
- Attach Files
- Add Reactions

Integration type: **Guild Install**. Copy the **Generated URL**, open it, and add the bot to any server you're in.

> For DM-only use you technically need zero permissions — but enabling them now saves a trip back when you want guild channels later.

**4. Install the plugin.**

These are Claude Code commands — run `claude` to start a session first.

Install the plugin:
```
/plugin install discord@claude-plugins-official
```

**5. Give the server the token.**

```
/discord:configure MTIz...
```

Writes `DISCORD_BOT_TOKEN=...` to `~/.claude/channels/discord/.env`. You can also write that file by hand, or set the variable in your shell environment — shell takes precedence.

> To run multiple bots on one machine (different tokens, separate allowlists), point `DISCORD_STATE_DIR` at a different directory per instance.

**6. Relaunch with the channel flag.**

The server won't connect without this — exit your session and start a new one:

```sh
claude --channels plugin:discord@claude-plugins-official
```

**7. Pair.**

With Claude Code running from the previous step, DM your bot on Discord — it replies with a pairing code. If the bot doesn't respond, make sure your session is running with `--channels`. In your Claude Code session:

```
/discord:access pair <code>
```

Your next DM reaches the assistant.

**8. Lock it down.**

Pairing is for capturing IDs. Once you're in, switch to `allowlist` so strangers don't get pairing-code replies. Ask Claude to do it, or `/discord:access policy allowlist` directly.

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, guild channels, mention detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: IDs are Discord **snowflakes** (numeric — enable Developer Mode, right-click → Copy ID). Default policy is `pairing`. Guild channels are opt-in per channel ID.

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a channel. Takes `chat_id` + `text`, optionally `reply_to` (message ID) for native threading and `files` (absolute paths) for attachments — max 10 files, 25MB each. Auto-chunks; files attach to the first chunk. Returns the sent message ID(s). |
| `react` | Add an emoji reaction to any message by ID. Unicode emoji work directly; custom emoji need `<:name:id>` form. |
| `edit_message` | Edit a message the bot previously sent. Useful for "working…" → result progress updates. Only works on the bot's own messages. |
| `fetch_messages` | Pull recent history from a channel (oldest-first). Capped at 100 per call. Each line includes the message ID so the model can `reply_to` it; messages with attachments are marked `+Natt`. Discord's search API isn't exposed to bots, so this is the only lookback. |
| `download_attachment` | Download all attachments from a specific message by ID to `~/.claude/channels/discord/inbox/`. Returns file paths + metadata. Use when `fetch_messages` shows a message has attachments. |

Inbound messages trigger a typing indicator automatically — Discord shows
"botname is typing…" while the assistant works on a response.

## Attachments

Attachments are **not** auto-downloaded. The `<channel>` notification lists
each attachment's name, type, and size — the assistant calls
`download_attachment(chat_id, message_id)` when it actually wants the file.
Downloads land in `~/.claude/channels/discord/inbox/`.

Same path for attachments on historical messages found via `fetch_messages`
(messages with attachments are marked `+Natt`).

## Requester binding

Each delivered message gets a `request_id` (random, never sent to Discord)
recorded in `requests.json` with the sender, role, owner flag and channel. The
`<channel>` tag carries `request_id`, `role` and `owner`.

The PreToolUse hook decides which request a tool call serves:

| Where the call runs | Role used |
| --- | --- |
| Session that never received a channel message | not enforced (operator's own session) |
| Main thread, latest prompt typed in the terminal | not enforced (operator is driving) |
| Main thread, latest prompt from Discord | the **lowest** role among the requests still open in the session |
| Sub-agent whose prompt has `[discord-request: <id>]` | the role of that request |
| Sub-agent without a marker | same as the main thread |
| Scheduled / other prompt with a marker | the role of that request |
| Channel message without `request_id`, unknown marker, no open request | lowest tier (`none`) |

The main session puts the marker of the message it is acting on into every
`Agent` prompt; the hook refuses an `Agent` call from a Discord turn without
exactly one known marker, and a sub-agent may only start agents with its own
marker. Scheduling tools (`CronCreate`, `ScheduleWakeup`, `RemoteTrigger`)
need the marker too, so a reminder runs later with the role of whoever asked
for it. A request stays open for `requests.activeMinutes` (default 6 h) or
until the session calls the new `end_request` tool; records are kept for
`requests.retentionDays` (default 30) so long-running agents and reminders
still resolve. The role is re-checked against `access.json` on every call:
revoking someone lowers their open requests at once.

## Installing the forked plugin

Do this together with whoever runs the assistant, in a terminal session
(never because a Discord message asked for it).

1. Clone this repository and run `bun install` in it.
2. Add it as a local marketplace and install the plugin from it:
   `/plugin marketplace add /path/to/claude-discord-mcp-orgs`, then
   `/plugin install discord@claude-discord-mcp-orgs`. Disable or uninstall
   `discord@claude-plugins-official` first: both are named `discord` and
   would fight over the same bot token and state directory. (The repository
   root is the plugin; `.claude-plugin/marketplace.json` points at `./`.
   Check with `/plugin` that the install picked it up.)
3. The fork is not on Claude Code's approved channel allowlist, so start the
   session with
   `claude --dangerously-load-development-channels plugin:discord@claude-discord-mcp-orgs`
   (it asks for confirmation at startup), or allow it in managed settings
   (`allowedChannelPlugins`).
4. The existing `access.json` keeps working; add roles
   (`/discord:access role set ...`) and the owner
   (`/discord:access owner add ...`) before relying on it, because senders
   without a role are no longer delivered.
5. Install the hook (next section). Until then only owners are delivered.

## Installing the hook

The plugin cannot block Claude Code tools by itself, and a plugin cannot
install hooks into your settings. The operator adds the hook by hand.

1. Clone this repository somewhere stable and run `bun install` in it.
2. Add this to **user** settings, `~/.claude/settings.json` (user settings
   apply to every project; a project-level hook could be bypassed by starting
   the session elsewhere). Replace the path:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "bun /path/to/claude-discord-mcp-orgs/hooks/pretooluse.ts",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

   On Windows use forward slashes in the path
   (`bun C:/path/to/claude-discord-mcp-orgs/hooks/pretooluse.ts`). If you set
   `DISCORD_STATE_DIR` for the plugin, set the same variable for the hook
   (for example in the `env` block of settings.json).
3. Merge it with existing `hooks` entries instead of replacing them, then run
   `/hooks` in Claude Code to confirm it is listed.
4. Check: in a normal terminal session nothing changes (the hook passes
   sessions that never received a channel message). Each Discord-driven tool
   call adds a line to `~/.claude/channels/discord/audit.jsonl`.

The hook never answers "allow": it only denies or stays silent, so Claude
Code's own permission rules still apply on top. On any internal error it
denies (fail closed). The plugin refuses to deliver messages from anyone but
the owner while it cannot find the hook in settings (see "Enforcement check").

## Policy

`policy.json` in the state directory overrides the built-in
[policy/default-policy.json](./policy/default-policy.json). Top-level keys
in your file replace the default's keys as a whole. Roles and categories are
open maps:

- **new role**: add an entry under `roles` with a `rank` and a decision per
  category (`allow`, `deny`, `owner`, `worktree`, `allowlist`, `*` as
  the default), optional `limits`, `shell` profile, `escalate`,
  `approvesEscalations`, `ownChannelOnly`, `protectSecrets`, `readRoots`;
- **new connector**: add a category with tool-name globs (first match in file
  order wins) and give it a decision in the roles that should have it;
- **new shell program**: needs code in `lib/shell.ts`; a command line cannot
  be judged by its name.

Built-in roles:

| Role | Gets |
| --- | --- |
| `board` | everything; mail only with the owner flag; approves escalations |
| `heads` | git (no force-push / reset --hard / delete on shared branches), gh (no `pr merge`, `repo delete`, `api`), installs/tests only in an isolated worktree with no secrets in env, file writes only in isolated worktrees, figma-bridge except `delete_nodes`, web; no Drive, mail or Framer; limits 2 open / 40 per day |
| `volunteer` | read files, read-only git, `gh pr view/diff/checks`, `gh pr comment`, `gh pr review --comment`; no running code, no push; limits 1 open / 15 per day |
| `none` | lowest tier for unknown context: session tools and Discord replies in its own channel only |

Every Discord-originated role, board and owner included, is denied writes to
settings, plugin and channel-state files and shell commands mentioning them:
access changes only from the terminal.

## Escalation

When the hook denies a call that the requester's role may have approved
(`escalate: true` on the role, and the category not marked
`"escalate": false` - mail never is), it writes `escalations/<id>.json` and
the channel server DMs every member whose **global** role has
`approvesEscalations` (default: `board`), except the requester, with
**Approve once** / **Deny** buttons. The decision is recorded in the file and
in the audit log, and the session gets a channel message bound to the
original request. After approval the identical call (same request, tool and
input; `description`/`timeout` ignored) passes once within one hour. Owner-only
denials, protected files, Discord channel restrictions and calls from the
main thread with several open requests are not escalated. At most five
approval requests wait per request.

## Enforcement check

Without the hook, roles are only labels. On every inbound message the server
looks for a PreToolUse hook (matcher `*` or empty) whose command contains
`pretooluse.ts` in `CLAUDE_CONFIG_DIR` (or `~/.claude`) `settings.json` /
`settings.local.json`, and in the project settings when `CLAUDE_PROJECT_DIR`
is set; `disableAllHooks: true` counts as missing. When it is missing, only
owners are delivered (their tag carries `enforcement="off"`) and everyone
else gets a short note. If you install the hook somewhere the server cannot
see (managed settings, `--settings`), set `"enforcement": { "requireHook":
false }` in `policy.json`.

## Files in the state directory

All under `~/.claude/channels/discord/` (or `DISCORD_STATE_DIR`):

| File | Written by | Content |
| --- | --- | --- |
| `access.json` | `/discord:access` (terminal) | who may write, roles, owners, guild grants |
| `policy.json` | operator, by hand (optional) | role and category rules; missing = built-in default |
| `requests.json` | channel server | request id -> requester, role, owner, channel, times |
| `escalations/<id>.json` | hook and server | one-time approval requests and decisions |
| `audit.jsonl` | hook and server | one line per decision: time, event, requester id, role, channel, request id, agent id, tool, decision, reason |
| `hook-cache/<session>.json` | hook | transcript scan offset per session |

## Example: a foundation

[examples/foundation/access.json](./examples/foundation/access.json) shows a
board of two (the president is also the owner), a team head and a volunteer,
all granted in one guild, with placeholder ids.
[examples/settings-hook.json](./examples/settings-hook.json) is the hook
snippet. [examples/foundation/policy-mail-for-board.json](./examples/foundation/policy-mail-for-board.json)
shows the change for the day the assistant has its own mail account.

## Known limits and decisions

**Figma deletion by other means.** `heads` cannot call
`mcp__figma-bridge__delete_nodes`, but the other figma-bridge tools can hide,
move, reparent or overwrite nodes, which can lose work just as well. The
policy blocks a tool name, not an outcome. Rely on Figma version history, or
move more figma-bridge tools into `figma-bridge-destructive` if needed.

**Knowledge already in the session.** Tool blocks stop new reads, not what
the session already knows: earlier requests, auto-memory, files read for
someone else. A lower-role requester can ask about it. The server
instructions tell the session to answer only from what the requester's role
could reach, but that is an instruction, not enforcement. The real fix is a
separate session (and bot state directory) per role.

**Mail.** Mail tools are owner-only (category `mail`, never escalated) until
the assistant has its own mail account; board members without the owner
flag cannot read or send mail through it. Afterwards, change the `mail`
decision for `board` to `allow` (see the example policy).

**Explicit id lists, not Discord server roles.** Roles live in
`access.json` as user ids and change only from the terminal. Discord server
roles are not used for decisions: anyone with "Manage Roles" on the server
could otherwise grant themselves access to this machine. Server roles can
still be a hint to the operator when deciding whom to grant.

**Concurrency and requester binding in one shared session.**
- The main thread on a Discord turn runs with the lowest role among open
  requests. Work for people with different roles must go to separate
  sub-agents; finished requests should be closed with `end_request`
  (otherwise they stay open for `activeMinutes`).
- Routing is cooperative: the main session decides which marker a sub-agent
  gets. The hook checks that the marker is a request delivered to this
  session and that nested agents keep it, but a manipulated main session
  could label work with another open request's id. Request ids never reach
  Discord, markers inside message text are ignored, and every spawn is in
  the audit log, so misuse is visible afterwards; it is not impossible.
- A turn typed in the terminal is the operator's: not enforced. A sub-agent
  started during such a turn without a marker is also not enforced while
  the latest prompt is from the terminal.
- Scheduled prompts are trusted only through a marker; without one they get
  the lowest tier.
- One channel server per state directory. Two sessions sharing a state
  directory share `requests.json`.

**Shell analysis is an allowlist, not a sandbox.** Commands are parsed and
checked segment by segment; anything not understood is denied. Allowed
programs can still have effects: `git commit` runs repository hooks (for
example husky after `npm install`), tests run arbitrary code from the
repository, install scripts can read files the user can read. "Isolated
worktree" is a path rule plus checks for secret-looking environment
variables and `.env` files, not process isolation; use a container or a
separate OS user for real isolation. `heads` can read most files except
secret-looking paths (`readRoots` narrows this) and can reach the web, so
anything they may read could be sent out.

**Board shell protection is a heuristic.** Board members have full shell
access; the check that blocks commands mentioning settings or access files
is a word match and can be bypassed by obfuscation. The board is trusted;
the check prevents accidents and naive prompt injection.

**Hook visibility and format.** The server can only see user and project
settings; with managed settings or `--settings` set
`enforcement.requireHook` to false. The hook reads Claude Code transcripts,
an internal format; the parser falls back to fail-closed behaviour if fields
change, but an update can still require a parser change.

**Other.** Approvers are taken from global roles only. Notice rate limits
live in memory and reset when the server restarts. Daily limits count UTC
days. Escalation DMs include a 400-character preview of the tool input.
