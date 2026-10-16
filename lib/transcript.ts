/**
 * Reads Claude Code transcripts (JSONL) to learn, for a tool call, which
 * prompt the session is working on.
 *
 * Main transcript: `<projects>/<session_id>.jsonl`. Prompts are `type:"user"`
 * entries with an `origin.kind`:
 *   - "channel": a channel notification; its text starts with
 *     `<channel source=... request_id="..." role="...">` written by Claude Code
 *     from the meta set by our server (message text cannot forge it);
 *   - "human": typed in the terminal by the operator;
 *   - "task-notification": a background agent finished (not a new prompt);
 *   - anything else (scheduled prompts, coordinators, ...): treated as
 *     "other", i.e. not the operator, and only trusted via request markers.
 * Entries without `origin` (tool results, local command echoes) are skipped.
 *
 * Sub-agent transcript: `<projects>/<session_id>/subagents/agent-<id>.jsonl`;
 * its first user entry is the prompt the parent wrote, where the request
 * marker must be.
 *
 * Scanning is incremental: the byte offset and the result so far are cached
 * per session, so each tool call reads only the new tail.
 */
import { closeSync, existsSync, openSync, readSync, statSync, readFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import { markersIn } from './requests.ts'
import { readJson, writeJsonAtomic } from './state.ts'

export type PromptInfo = {
  kind: 'human' | 'channel' | 'other'
  /** request_id attribute of a channel prompt, when present. */
  requestId?: string
  /** Request markers found in the prompt text. */
  markers: string[]
}

export type ScanState = {
  version: 1
  offset: number
  sawChannel: boolean
  /** Request ids delivered to this session (from channel tags). */
  seen: string[]
  /** Channel prompts that had no request_id (e.g. the upstream plugin). */
  unbound: number
  last: PromptInfo | null
  /** agent_id -> markers from the agent's first prompt. */
  agents: Record<string, string[]>
}

export function emptyScan(): ScanState {
  return { version: 1, offset: 0, sawChannel: false, seen: [], unbound: 0, last: null, agents: {} }
}

const TAG_RE = /^\s*<channel\s+([^>]*)>/
const ATTR_RE = /([a-zA-Z_]+)="([^"]*)"/g

export function channelAttrs(text: string): Record<string, string> | null {
  const m = TAG_RE.exec(text)
  if (!m) return null
  const out: Record<string, string> = {}
  for (const a of m[1]!.matchAll(ATTR_RE)) out[a[1]!] = a[2]!
  return out
}

export function entryText(entry: any): string {
  const c = entry?.message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c.filter((b: any) => b && b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n')
  }
  return ''
}

/** Classify one transcript entry; null = not a prompt. */
export function classify(entry: any): PromptInfo | null {
  if (!entry || entry.type !== 'user') return null
  const text = entryText(entry)
  let kind = entry.origin?.kind
  // Fallback if a future Claude Code version drops origin: a prompt that
  // starts with a channel tag is still a channel prompt. Without this the
  // hook would see no channel messages and stop enforcing (fail open).
  // Unmarked human prompts are then not recognised, which fails closed.
  if (!kind && channelAttrs(text)?.source) kind = 'channel'
  if (!kind || kind === 'task-notification') return null
  if (kind === 'human') return { kind: 'human', markers: markersIn(text) }
  if (kind === 'channel') {
    const attrs = channelAttrs(text) ?? {}
    const rid = attrs.request_id
    return { kind: 'channel', requestId: rid && /^dr_[0-9a-f]{16}$/.test(rid) ? rid : undefined, markers: [] }
  }
  return { kind: 'other', markers: markersIn(text) }
}

function readFrom(file: string, offset: number): { text: string; size: number } {
  const size = statSync(file).size
  if (size <= offset) return { text: '', size }
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(size - offset)
    let read = 0
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, offset + read)
      if (n <= 0) break
      read += n
    }
    return { text: buf.subarray(0, read).toString('utf8'), size: offset + read }
  } finally {
    closeSync(fd)
  }
}

/** Advance the scan over new complete lines of the main transcript. */
export function scanTranscript(file: string, prev: ScanState): ScanState {
  const s: ScanState = { ...prev, seen: [...prev.seen], agents: { ...prev.agents } }
  if (!existsSync(file)) return s
  let size: number
  try { size = statSync(file).size } catch { return s }
  if (size < s.offset) Object.assign(s, emptyScan(), { agents: s.agents }) // file was replaced: rescan
  const { text } = readFrom(file, s.offset)
  const end = text.lastIndexOf('\n')
  if (end < 0) return s
  const chunk = text.slice(0, end + 1)
  s.offset += Buffer.byteLength(chunk, 'utf8')
  const seen = new Set(s.seen)
  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue
    let entry: any
    try { entry = JSON.parse(line) } catch { continue }
    const p = classify(entry)
    if (!p) continue
    if (p.kind === 'channel') {
      s.sawChannel = true
      if (p.requestId) seen.add(p.requestId)
      else s.unbound++
    }
    s.last = p
  }
  s.seen = [...seen]
  return s
}

/** Resolve the main transcript path and the agent transcript path from hook input. */
export function transcriptPaths(transcriptPath: string, sessionId: string, agentId?: string): { main: string; agent?: string } {
  let main = transcriptPath
  // Defensive: if Claude Code ever passes the agent's own transcript, walk up.
  if (/^agent-.*\.jsonl$/.test(basename(transcriptPath)) && basename(dirname(transcriptPath)) === 'subagents') {
    const sessionDir = dirname(dirname(transcriptPath))
    main = join(dirname(sessionDir), `${basename(sessionDir)}.jsonl`)
  }
  if (!agentId) return { main }
  const agent = join(dirname(main), sessionId, 'subagents', `agent-${agentId}.jsonl`)
  return { main, agent }
}

/** Markers in the first prompt of a sub-agent transcript; null if not readable yet. */
export function agentMarkers(agentFile: string): string[] | null {
  let raw: string
  try { raw = readFileSync(agentFile, 'utf8') } catch { return null }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let entry: any
    try { entry = JSON.parse(line) } catch { continue }
    if (entry?.type === 'user') return markersIn(entryText(entry))
  }
  return null
}

function cacheFile(cacheDir: string, sessionId: string): string {
  return join(cacheDir, `${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
}

export function loadScan(cacheDir: string, sessionId: string): ScanState {
  try {
    const s = readJson<ScanState>(cacheFile(cacheDir, sessionId), emptyScan())
    return s?.version === 1 ? s : emptyScan()
  } catch {
    return emptyScan()
  }
}

export function saveScan(cacheDir: string, sessionId: string, s: ScanState): void {
  try { writeJsonAtomic(cacheFile(cacheDir, sessionId), s) } catch {}
}
