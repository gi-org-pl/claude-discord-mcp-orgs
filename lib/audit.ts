/**
 * Append-only audit log (JSON Lines). One line per decision, written by the
 * channel server (inbound messages, permission relay, escalations) and by
 * the PreToolUse hook (tool calls). Lines are small, so appends from the two
 * processes do not interleave in practice.
 */
import { appendFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'

export type AuditEntry = {
  /** ISO time, filled in by appendAudit when missing. */
  time?: string
  /** What happened: inbound, tool, escalation, permission_relay, ... */
  event: string
  requester_id?: string
  role?: string
  owner?: boolean
  channel?: string
  request_id?: string
  agent_id?: string
  session_id?: string
  tool?: string
  decision: string
  reason?: string
  [key: string]: unknown
}

const MAX_FIELD = 500

function clip(v: unknown): unknown {
  if (typeof v === 'string' && v.length > MAX_FIELD) return v.slice(0, MAX_FIELD) + '…'
  return v
}

export function formatAudit(entry: AuditEntry, now: Date = new Date()): string {
  const out: Record<string, unknown> = { time: entry.time ?? now.toISOString() }
  for (const [k, v] of Object.entries(entry)) {
    if (k === 'time' || v === undefined) continue
    out[k] = clip(v)
  }
  // JSON.stringify escapes newlines, so one entry is always one line.
  return JSON.stringify(out) + '\n'
}

/** Never throws: a failing audit write must not take down the server or the hook. */
export function appendAudit(file: string, entry: AuditEntry, now?: Date): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    appendFileSync(file, formatAudit(entry, now), { mode: 0o600 })
    return true
  } catch (err) {
    process.stderr.write(`discord: audit write failed: ${err}\n`)
    return false
  }
}
