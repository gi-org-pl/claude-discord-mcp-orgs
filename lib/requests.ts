/**
 * Request registry (requests.json in the state dir).
 *
 * Every delivered Discord message becomes a request with a random id. The id
 * goes into the <channel> tag; the main session passes it to sub-agents as a
 * marker (`[discord-request: dr_...]`). The PreToolUse hook looks the id up
 * here to learn who asked, with which role, from which channel. The channel
 * server is the only writer; the hook only reads.
 *
 * Ids are random (64 bits) and never sent to Discord (see scrubRequestIds),
 * so a sender cannot name another person's request.
 */
import { randomBytes } from 'crypto'
import { readJson, writeJsonAtomic } from './state.ts'

export type RequestRecord = {
  id: string
  requester_id: string
  role: string
  owner: boolean
  chat_id: string
  message_id: string
  guild_id: string | null
  channel_key: string | null
  created_at: number
  ended_at?: number
}

export type RequestState = { version: 1; requests: Record<string, RequestRecord> }

export const REQUEST_ID_PATTERN = 'dr_[0-9a-f]{16}'
export const MARKER_RE = /\[discord-request:\s*(dr_[0-9a-f]{16})\s*\]/g

export function newRequestId(): string {
  return 'dr_' + randomBytes(8).toString('hex')
}

export function marker(id: string): string {
  return `[discord-request: ${id}]`
}

/** All distinct request ids named by markers in a text. */
export function markersIn(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(MARKER_RE)) out.add(m[1]!)
  return [...out]
}

/** Request ids must never reach Discord: replace them before sending. */
export function scrubRequestIds(text: string): string {
  return text.replace(new RegExp(REQUEST_ID_PATTERN, 'g'), '[request]')
}

export function emptyState(): RequestState {
  return { version: 1, requests: {} }
}

export function loadRequests(file: string): RequestState {
  try {
    const s = readJson<RequestState>(file, emptyState())
    return s && typeof s.requests === 'object' ? s : emptyState()
  } catch {
    return emptyState()
  }
}

export function saveRequests(file: string, s: RequestState): void {
  writeJsonAtomic(file, s)
}

export function isActive(r: RequestRecord, now: number, activeMinutes: number): boolean {
  return !r.ended_at && now - r.created_at < activeMinutes * 60_000
}

export function prune(s: RequestState, now: number, retentionDays: number): void {
  const cutoff = now - retentionDays * 86_400_000
  for (const [id, r] of Object.entries(s.requests)) {
    if (r.created_at < cutoff) delete s.requests[id]
  }
}

export type Limits = { maxConcurrent?: number; dailyRequests?: number }

function utcDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10)
}

/** 0 or missing = unlimited. */
export function checkLimits(
  s: RequestState, userId: string, limits: Limits | undefined, now: number, activeMinutes: number,
): { ok: true } | { ok: false; reason: string } {
  const mine = Object.values(s.requests).filter(r => r.requester_id === userId)
  const maxC = limits?.maxConcurrent ?? 0
  if (maxC > 0) {
    const active = mine.filter(r => isActive(r, now, activeMinutes)).length
    if (active >= maxC) return { ok: false, reason: `concurrent limit ${maxC} reached` }
  }
  const maxD = limits?.dailyRequests ?? 0
  if (maxD > 0) {
    const today = utcDay(now)
    const count = mine.filter(r => utcDay(r.created_at) === today).length
    if (count >= maxD) return { ok: false, reason: `daily limit ${maxD} reached` }
  }
  return { ok: true }
}

export function endRequest(s: RequestState, id: string, now: number): boolean {
  const r = s.requests[id]
  if (!r || r.ended_at) return false
  r.ended_at = now
  return true
}
