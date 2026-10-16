/**
 * access.json schema and the pure parts of the inbound gate.
 *
 * Upstream keyed everything on channel ids plus a DM allowlist. This fork adds:
 * - `members`: user id -> role (the role decides what a request may do; see
 *   policy.ts). Roles are explicit id lists, never Discord server roles.
 * - `owners`: user ids of the machine owner. A separate flag, not a role: it
 *   unlocks owner-only connectors (mail) and permission-prompt relay.
 * - `guilds`: guild-level grants per user. They cover every channel of the
 *   guild, including channels created later; threads inherit. A per-channel
 *   entry in `groups` overrides the guild rule for that channel.
 * - default deny: a sender who passes the gate but has no role is not
 *   delivered to the session.
 */
import { randomBytes } from 'crypto'

export type PendingEntry = {
  senderId: string
  chatId: string // DM channel ID — where to send the approval confirm
  createdAt: number
  expiresAt: number
  replies: number
}

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
  /** Optional per-channel role override: user id -> role name. */
  roles?: Record<string, string>
}

export type GuildMemberRule = {
  /** Role inside this guild. Falls back to the global `members` role when absent. */
  role?: string
  /** Default true: the user must @mention (or reply to) the bot. */
  requireMention?: boolean
}

export type GuildRule = {
  members: Record<string, GuildMemberRule>
}

export type MemberRule = {
  role?: string
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  /** Keyed on channel ID (snowflake), not guild ID. One entry per guild channel. */
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  // delivery/UX config — optional, defaults live in the reply handler
  /** Emoji to react with on receipt. Empty string disables. Unicode char or custom emoji ID. */
  ackReaction?: string
  /** Which chunks get Discord's reply reference when reply_to is passed. Default: 'first'. 'off' = never thread. */
  replyToMode?: 'off' | 'first' | 'all'
  /** Max chars per outbound message before splitting. Default: 2000 (Discord's hard cap). */
  textChunkLimit?: number
  /** Split on paragraph boundaries instead of hard char count. */
  chunkMode?: 'length' | 'newline'
  /** Global roles: user id -> { role }. */
  members: Record<string, MemberRule>
  /** Machine owner(s). Separate from roles. */
  owners: string[]
  /** Guild-level grants keyed on guild ID. */
  guilds: Record<string, GuildRule>
  /** Reply once with a short "no permissions" note when a sender has no role. Default true. */
  noRoleNotice?: boolean
}

export function defaultAccess(): Access {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    groups: {},
    pending: {},
    members: {},
    owners: [],
    guilds: {},
  }
}

export function normalizeAccess(parsed: Partial<Access>): Access {
  return {
    dmPolicy: parsed.dmPolicy ?? 'pairing',
    allowFrom: parsed.allowFrom ?? [],
    groups: parsed.groups ?? {},
    pending: parsed.pending ?? {},
    mentionPatterns: parsed.mentionPatterns,
    ackReaction: parsed.ackReaction,
    replyToMode: parsed.replyToMode,
    textChunkLimit: parsed.textChunkLimit,
    chunkMode: parsed.chunkMode,
    members: parsed.members ?? {},
    owners: parsed.owners ?? [],
    guilds: parsed.guilds ?? {},
    noRoleNotice: parsed.noRoleNotice,
  }
}

/** Where a message came from, reduced to the ids the gate needs. */
export type Origin = {
  userId: string
  /** Guild id, absent for DMs. */
  guildId?: string | null
  /** Channel key used for `groups`: the parent channel for threads. */
  channelKey?: string | null
}

/**
 * Role of a user in a given place. Most specific wins:
 * channel override -> guild grant -> global member role -> none (null).
 */
export function resolveRole(access: Access, o: Origin): string | null {
  const fromChannel = o.channelKey ? access.groups[o.channelKey]?.roles?.[o.userId] : undefined
  if (fromChannel) return fromChannel
  const fromGuild = o.guildId ? access.guilds[o.guildId]?.members?.[o.userId]?.role : undefined
  if (fromGuild) return fromGuild
  return access.members[o.userId]?.role ?? null
}

export function isOwner(access: Access, userId: string): boolean {
  return access.owners.includes(userId)
}

export type InboundInfo = {
  senderId: string
  isDM: boolean
  /** Channel the message was posted in (the thread id for threads). */
  channelId: string
  /** Parent channel for threads, null otherwise. */
  parentId?: string | null
  guildId?: string | null
}

export type Requester = {
  userId: string
  role: string
  owner: boolean
  guildId: string | null
  channelKey: string | null
}

export type GateResult =
  | { action: 'deliver'; access: Access; requester: Requester }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }
  | { action: 'no_role'; access: Access; userId: string }

export type GateDeps = {
  /** Lazily evaluated: only called when a mention is actually required. */
  isMentioned: () => Promise<boolean>
  save: (a: Access) => void
  now?: () => number
  newCode?: () => string
}

export function pruneExpired(a: Access, now: number = Date.now()): boolean {
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

export async function evaluateGate(access: Access, info: InboundInfo, deps: GateDeps): Promise<GateResult> {
  const now = deps.now?.() ?? Date.now()
  if (pruneExpired(access, now)) deps.save(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const senderId = info.senderId

  const withRole = (guildId: string | null, channelKey: string | null): GateResult => {
    const role = resolveRole(access, { userId: senderId, guildId, channelKey })
    if (!role) return { action: 'no_role', access, userId: senderId }
    return {
      action: 'deliver',
      access,
      requester: { userId: senderId, role, owner: isOwner(access, senderId), guildId, channelKey },
    }
  }

  if (info.isDM) {
    if (access.allowFrom.includes(senderId)) return withRole(null, null)
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    // pairing mode — check for existing non-expired code for this sender
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        // Reply twice max (initial + one reminder), then go silent.
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        deps.save(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    // Cap pending at 3. Extra attempts are silently dropped.
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    const code = deps.newCode?.() ?? randomBytes(3).toString('hex') // 6 hex chars
    access.pending[code] = {
      senderId,
      chatId: info.channelId, // DM channel ID — used later to confirm approval
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000, // 1h
      replies: 1,
    }
    deps.save(access)
    return { action: 'pair', code, isResend: false }
  }

  // Threads inherit their parent channel's opt-in; the reply still goes to
  // the thread, this is only the gate lookup.
  const channelKey = info.parentId ?? info.channelId
  const guildId = info.guildId ?? null
  const policy = access.groups[channelKey]
  if (policy) {
    // A per-channel entry overrides any guild-level rule.
    const groupAllowFrom = policy.allowFrom ?? []
    const requireMention = policy.requireMention ?? true
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) return { action: 'drop' }
    if (requireMention && !(await deps.isMentioned())) return { action: 'drop' }
    return withRole(guildId, channelKey)
  }

  const member = guildId ? access.guilds[guildId]?.members?.[senderId] : undefined
  if (!member) return { action: 'drop' }
  if ((member.requireMention ?? true) && !(await deps.isMentioned())) return { action: 'drop' }
  return withRole(guildId, channelKey)
}

/** Outbound gate: may tools target this (non-DM) channel? */
export function guildChannelAllowed(access: Access, channelKey: string, guildId: string | null | undefined): boolean {
  if (channelKey in access.groups) return true
  return !!guildId && guildId in access.guilds
}
