/**
 * Escalations: a tool call denied for a requester's role can be approved
 * once by an approver (a role with `approvesEscalations`, by default the
 * board).
 *
 * One JSON file per escalation in `escalations/` under the state dir:
 * - the hook creates it (status "pending") when it denies an escalatable call;
 * - the channel server DMs approvers with Approve / Deny buttons and records
 *   the decision ("approved" / "denied", by whom, when);
 * - the hook lets the identical call (same request, same tool, same input)
 *   through once and marks the escalation "used".
 * Every step is also written to the audit log.
 */
import { createHash, randomBytes } from 'crypto'
import { readdirSync } from 'fs'
import { join } from 'path'
import { readJson, writeJsonAtomic } from './state.ts'

export type EscalationStatus = 'pending' | 'approved' | 'denied' | 'used'

export type Escalation = {
  id: string
  request_id: string
  requester_id: string
  role: string
  chat_id: string
  tool: string
  input_preview: string
  input_hash: string
  reason: string
  created_at: number
  status: EscalationStatus
  notified_at?: number
  decided_by?: string
  decided_at?: number
  used_at?: number
}

export const ESCALATION_ID_RE = /^e_[0-9a-f]{10}$/
/** An approval is valid for one use within this window. */
export const APPROVAL_TTL_MS = 60 * 60 * 1000
const MAX_PENDING_PER_REQUEST = 5
/** Fields that do not change what a call does. */
const VOLATILE_INPUT_KEYS = new Set(['description', 'timeout', 'run_in_background'])

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as object).sort()) out[k] = stable((v as Record<string, unknown>)[k])
    return out
  }
  return v
}

export function inputHash(tool: string, input: Record<string, unknown>): string {
  const clean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input ?? {})) if (!VOLATILE_INPUT_KEYS.has(k)) clean[k] = v
  return createHash('sha256').update(tool + '\0' + JSON.stringify(stable(clean))).digest('hex')
}

export function preview(input: Record<string, unknown>, max = 400): string {
  const s = JSON.stringify(input ?? {})
  return s.length > max ? s.slice(0, max) + '…' : s
}

function file(dir: string, id: string): string {
  return join(dir, `${id}.json`)
}

export function listEscalations(dir: string): Escalation[] {
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  const out: Escalation[] = []
  for (const n of names) {
    const id = n.replace(/\.json$/, '')
    if (!ESCALATION_ID_RE.test(id)) continue
    try {
      const e = readJson<Escalation | null>(file(dir, id), null)
      if (e) out.push(e)
    } catch {}
  }
  return out.sort((a, b) => a.created_at - b.created_at)
}

export function readEscalation(dir: string, id: string): Escalation | null {
  if (!ESCALATION_ID_RE.test(id)) return null
  try { return readJson<Escalation | null>(file(dir, id), null) } catch { return null }
}

export function writeEscalation(dir: string, e: Escalation): void {
  writeJsonAtomic(file(dir, e.id), e)
}

export type EscalationRequest = Omit<Escalation, 'id' | 'created_at' | 'status' | 'input_hash' | 'input_preview'> & {
  input: Record<string, unknown>
}

/**
 * For a denied call: use an existing approval, report an existing pending or
 * denied escalation, or open a new one.
 */
export function escalate(dir: string, r: EscalationRequest, now: number):
  | { kind: 'approved'; esc: Escalation }
  | { kind: 'pending'; esc: Escalation; created: boolean }
  | { kind: 'denied'; esc: Escalation }
  | { kind: 'capped' } {
  const hash = inputHash(r.tool, r.input)
  const same = listEscalations(dir).filter(e => e.request_id === r.request_id && e.input_hash === hash)
  const approved = same.find(e => e.status === 'approved' && now - (e.decided_at ?? 0) < APPROVAL_TTL_MS)
  if (approved) {
    approved.status = 'used'
    approved.used_at = now
    writeEscalation(dir, approved)
    return { kind: 'approved', esc: approved }
  }
  const denied = same.find(e => e.status === 'denied')
  if (denied) return { kind: 'denied', esc: denied }
  const pending = same.find(e => e.status === 'pending')
  if (pending) return { kind: 'pending', esc: pending, created: false }
  const open = listEscalations(dir).filter(e => e.request_id === r.request_id && e.status === 'pending')
  if (open.length >= MAX_PENDING_PER_REQUEST) return { kind: 'capped' }
  const { input, ...rest } = r
  const esc: Escalation = {
    ...rest,
    id: 'e_' + randomBytes(5).toString('hex'),
    input_hash: hash,
    input_preview: preview(input),
    created_at: now,
    status: 'pending',
  }
  writeEscalation(dir, esc)
  return { kind: 'pending', esc, created: true }
}

/** Approver's decision. Returns null when the escalation is unknown or already decided. */
export function decideEscalation(dir: string, id: string, approve: boolean, by: string, now: number): Escalation | null {
  const e = readEscalation(dir, id)
  if (!e || e.status !== 'pending') return null
  e.status = approve ? 'approved' : 'denied'
  e.decided_by = by
  e.decided_at = now
  writeEscalation(dir, e)
  return e
}

export function unnotified(dir: string): Escalation[] {
  return listEscalations(dir).filter(e => e.status === 'pending' && !e.notified_at)
}

export function markNotified(dir: string, e: Escalation, now: number): void {
  e.notified_at = now
  writeEscalation(dir, e)
}
