/**
 * PreToolUse decision: which request does this tool call serve, with which
 * role, and does the policy allow it?
 *
 * Context resolution (see README "Requester binding"):
 * 1. A session that has never received a channel message is not ours: pass.
 * 2. Sub-agent call (`agent_id` present): the request marker in the agent's
 *    first prompt decides. Exactly one known marker = that request's role.
 *    Several markers = lowest tier. No marker = fall back to step 3.
 * 3. Main thread: if the latest prompt was typed in the terminal ("human"),
 *    the operator is driving: pass. Otherwise the role is the LOWEST among
 *    the requests still open in this session (plus any marker in a
 *    non-channel prompt such as a scheduled one). A channel prompt without a
 *    request id, or no open request at all, = lowest tier.
 * The role of a request is re-checked against access.json on every call, so
 * revoking a role takes effect at once (min of role at request time and now).
 *
 * "pass" means no output: Claude Code's own permission rules still apply.
 * The hook never returns "allow", so it can only narrow what the session
 * may do, never widen it.
 */
import { join } from 'path'
import { type Access, normalizeAccess, resolveRole } from './access.ts'
import { type AuditEntry } from './audit.ts'
import { type Policy, evaluate, loadPolicy, minRole, roleDef, type Verdict } from './policy.ts'
import { isActive, loadRequests, markersIn, marker, type RequestRecord, type RequestState } from './requests.ts'
import { readJson, statePaths, type StatePaths } from './state.ts'
import { escalate } from './escalations.ts'
import { agentMarkers, loadScan, saveScan, scanTranscript, transcriptPaths, type ScanState } from './transcript.ts'

export type HookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  tool_name: string
  tool_input: Record<string, unknown>
  agent_id?: string
  agent_type?: string
  hook_event_name?: string
  tool_use_id?: string
}

export type HookDeps = {
  stateDir: string
  env: Record<string, string | undefined>
  home: string
  now: number
  /** Directory of the installed hook/fork: protected from Discord-driven writes. */
  installDir: string
}

export type HookResult = {
  /** JSON to print on stdout, or null for "no objection". */
  output: Record<string, unknown> | null
  audit?: AuditEntry
  /** Filled when a denied call may be escalated (used by escalation flow). */
  escalation?: { request: RequestRecord; verdict: Verdict }
}

export function denyOutput(reason: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[discord access policy] ${reason}`,
    },
  }
}

const AGENT_TOOLS = new Set(['Agent', 'Task'])
const SCHEDULING_TOOLS = new Set(['CronCreate', 'ScheduleWakeup', 'RemoteTrigger'])

type Context = {
  mode: 'agent' | 'main'
  requests: RequestRecord[]
  /** Set when the context is the lowest tier for a specific reason. */
  forcedNone?: string
  agentMarker?: string
}

function effective(p: Policy, access: Access, ctx: Context): { role: string; owner: boolean } {
  if (ctx.forcedNone || ctx.requests.length === 0) return { role: 'none', owner: false }
  let role: string | null = null
  let owner = true
  for (const r of ctx.requests) {
    const now = resolveRole(access, { userId: r.requester_id, guildId: r.guild_id, channelKey: r.channel_key })
    const rr = minRole(p, r.role, now)
    role = role === null ? rr : minRole(p, role, rr)
    owner = owner && r.owner && access.owners.includes(r.requester_id)
  }
  return { role: roleDef(p, role).name, owner }
}

export function resolveContext(
  input: HookInput, scan: ScanState, store: RequestState, policy: Policy, now: number,
): Context | 'pass' {
  const seen = new Set(scan.seen)
  const known = (id: string) => seen.has(id) && !!store.requests[id]

  if (input.agent_id) {
    const markers = scan.agents[input.agent_id] ?? []
    if (markers.length > 1) return { mode: 'agent', requests: [], forcedNone: 'sub-agent prompt names several requests' }
    if (markers.length === 1) {
      const id = markers[0]!
      if (!known(id)) return { mode: 'agent', requests: [], forcedNone: `sub-agent marker ${id} is not a request of this session`, agentMarker: id }
      return { mode: 'agent', requests: [store.requests[id]!], agentMarker: id }
    }
    // No marker: same rules as the main thread.
  }

  const last = scan.last
  if (last?.kind === 'human') return 'pass'
  if (last?.kind === 'channel' && !last.requestId) {
    return { mode: input.agent_id ? 'agent' : 'main', requests: [], forcedNone: 'channel message without request id (is the fork running?)' }
  }
  const ids = new Set(scan.seen.filter(id => store.requests[id] && isActive(store.requests[id]!, now, policy.requests.activeMinutes)))
  if (last?.kind === 'other') for (const m of last.markers) if (known(m)) ids.add(m)
  const requests = [...ids].map(id => store.requests[id]!)
  return { mode: input.agent_id ? 'agent' : 'main', requests, forcedNone: requests.length ? undefined : 'no open request' }
}

export function decide(input: HookInput, deps: HookDeps): HookResult {
  const paths: StatePaths = statePaths(deps.stateDir)
  const tp = transcriptPaths(input.transcript_path ?? '', input.session_id ?? 'unknown', input.agent_id)

  let scan = scanTranscript(tp.main, loadScan(paths.hookCache, input.session_id ?? 'unknown'))
  if (input.agent_id && tp.agent && !(input.agent_id in scan.agents)) {
    const m = agentMarkers(tp.agent)
    if (m) scan.agents[input.agent_id] = m
  }
  saveScan(paths.hookCache, input.session_id ?? 'unknown', scan)

  // Not a channel session: the operator's own work, nothing to enforce.
  if (!scan.sawChannel) return { output: null }

  // From here on, any failure must deny (fail closed): loadPolicy throws on a broken file.
  const policy = loadPolicy(paths.policy)
  const store = loadRequests(paths.requests)
  const access = normalizeAccess(readJson<Partial<Access>>(paths.access, {}))

  const ctx = resolveContext(input, scan, store, policy, deps.now)
  if (ctx === 'pass') return { output: null }

  const eff = effective(policy, access, ctx)
  const requestChats = [...new Set(ctx.requests.map(r => r.chat_id))]
  const tool = input.tool_name
  const toolInput = input.tool_input ?? {}

  const base: AuditEntry = {
    event: 'tool',
    session_id: input.session_id,
    agent_id: input.agent_id,
    request_id: ctx.requests.map(r => r.id).join(',') || undefined,
    requester_id: [...new Set(ctx.requests.map(r => r.requester_id))].join(',') || undefined,
    role: eff.role,
    owner: eff.owner,
    channel: requestChats.join(',') || undefined,
    tool,
    decision: 'deny',
  }
  const deny = (reason: string, extra: Partial<AuditEntry> = {}): HookResult => ({
    output: denyOutput(reason),
    audit: { ...base, ...extra, decision: 'deny', reason },
  })

  // Request markers on agent and scheduling tools bind the new work to a request.
  if (AGENT_TOOLS.has(tool) || SCHEDULING_TOOLS.has(tool)) {
    const text = String(toolInput.prompt ?? '')
    const ms = markersIn(text)
    if (ctx.mode === 'agent' && ctx.agentMarker) {
      if (ms.length !== 1 || ms[0] !== ctx.agentMarker) {
        return deny(`work started from a sub-agent must carry the same marker: add ${marker(ctx.agentMarker)} to the prompt`)
      }
    } else {
      if (ms.length !== 1) {
        return deny(`name the request this work is for: put exactly one marker ${marker('<request_id>')} (request_id from the message's channel tag) in the prompt`)
      }
      const id = ms[0]!
      if (!new Set(scan.seen).has(id) || !store.requests[id]) return deny(`marker ${id} is not a request delivered to this session`)
    }
  }

  const verdict = evaluate(policy, {
    role: eff.role,
    owner: eff.owner,
    tool,
    input: toolInput,
    cwd: input.cwd || deps.home,
    home: deps.home,
    env: deps.env,
    requestChats,
    extraProtected: [deps.stateDir, deps.installDir],
  })
  const audit: AuditEntry = { ...base, category: verdict.category, decision: verdict.allow ? 'allow' : 'deny', reason: ctx.forcedNone ? `${verdict.reason} (${ctx.forcedNone})` : verdict.reason }
  if (verdict.allow) return { output: null, audit }

  let reason = verdict.reason
  if (ctx.forcedNone) reason += ` (lowest tier: ${ctx.forcedNone})`
  else if (ctx.mode === 'main' && ctx.requests.length > 1) {
    reason += ' (main thread runs with the lowest role among open requests; delegate to a sub-agent with the request marker, or end finished requests with end_request)'
  }
  const result: HookResult = { output: denyOutput(reason), audit: { ...audit, reason } }
  if (!(verdict.escalatable && ctx.requests.length === 1 && !ctx.forcedNone)) return result

  // Escalation: one-time approval by an approver role (see lib/escalations.ts).
  const request = ctx.requests[0]!
  result.escalation = { request, verdict }
  const esc = escalate(paths.escalations, {
    request_id: request.id,
    requester_id: request.requester_id,
    role: eff.role,
    chat_id: request.chat_id,
    tool,
    input: toolInput,
    reason: verdict.reason,
  }, deps.now)
  switch (esc.kind) {
    case 'approved':
      return {
        output: null,
        audit: { ...audit, decision: 'allow', reason: `approved once by ${esc.esc.decided_by} (escalation ${esc.esc.id})`, escalation_id: esc.esc.id },
      }
    case 'pending': {
      const why = `${reason}. ${esc.created ? 'Sent' : 'Already sent'} to approvers for a one-time approval (escalation ${esc.esc.id}); tell the requester, and retry the identical call only after it is approved`
      return { output: denyOutput(why), audit: { ...audit, reason: why, escalation_id: esc.esc.id }, escalation: result.escalation }
    }
    case 'denied': {
      const why = `${reason}. An approver already declined this call (escalation ${esc.esc.id})`
      return { output: denyOutput(why), audit: { ...audit, reason: why, escalation_id: esc.esc.id } }
    }
    case 'capped': {
      const why = `${reason}. Too many approval requests are already waiting for this request`
      return { output: denyOutput(why), audit: { ...audit, reason: why } }
    }
  }
}

export function installDirOf(hookFile: string): string {
  return join(hookFile, '..', '..')
}
