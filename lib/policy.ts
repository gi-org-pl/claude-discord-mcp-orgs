/**
 * Per-role tool policy.
 *
 * The policy is data (policy.json in the state dir, or the built-in default in
 * policy/default-policy.json). Roles and categories are open maps keyed by
 * name, so adding a role or a connector is a JSON edit:
 *
 * - a new role       = one entry in `roles` (rank + category decisions);
 * - a new connector  = one entry in `categories` (tool-name globs), then a
 *                      decision for it in the roles that should get it;
 * - a new shell tool = code: a new analyser in lib/shell.ts, because a
 *                      command line cannot be judged by its name.
 *
 * Decisions per category: allow | deny | owner (only with the owner flag) |
 * worktree (file writes inside an isolated worktree) | allowlist (shell
 * commands checked by lib/shell.ts against the role's `shell` profile).
 */
import { readFileSync } from 'fs'
import defaultPolicyJson from '../policy/default-policy.json'
import { analyzeShell, isIsolatedWorktree, isSecretPath, type ShellContext } from './shell.ts'
import { matchesAny, normalizePath } from './paths.ts'

export type CategoryDecision = 'allow' | 'deny' | 'owner' | 'worktree' | 'allowlist'

export type RoleDef = {
  rank: number
  description?: string
  categories: Record<string, CategoryDecision>
  shell?: Record<string, string>
  limits?: { maxConcurrent?: number; dailyRequests?: number }
  /** Denials for this role may be sent to approvers for a one-time approval. */
  escalate?: boolean
  /** Members of this role may approve escalations. */
  approvesEscalations?: boolean
  /** Discord tools may only target the channel(s) of the role's own requests. */
  ownChannelOnly?: boolean
  /** Reads of secret-looking paths are denied. */
  protectSecrets?: boolean
  /** Optional: reads only below these path globs. */
  readRoots?: string[]
}

export type CategoryDef = { tools: string[]; escalate?: boolean }

export type Policy = {
  version: number
  roles: Record<string, RoleDef>
  categories: Record<string, CategoryDef>
  sharedBranches: string[]
  worktreeRoots: string[]
  secretPaths: string[]
  secretPathExceptions: string[]
  protectedPaths: string[]
  protectedShellWords: string[]
  secretEnv: { pattern: string; allow: string[] }
  requests: { activeMinutes: number; retentionDays: number }
  /** requireHook (default true): refuse non-owners while the hook is not installed. */
  enforcement?: { requireHook?: boolean }
}

export const NONE_ROLE = 'none'

export function defaultPolicy(): Policy {
  return structuredClone(defaultPolicyJson) as Policy
}

/**
 * Load policy.json. Missing file = built-in default. Top-level keys present
 * in the file replace the default's keys as a whole (no deep merge, so what
 * the file says is exactly what applies). Invalid file throws: callers fail
 * closed.
 */
export function loadPolicy(file: string): Policy {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultPolicy()
    throw err
  }
  const parsed = JSON.parse(raw) as Partial<Policy>
  const p = { ...defaultPolicy(), ...parsed } as Policy
  validatePolicy(p)
  return p
}

export function validatePolicy(p: Policy): void {
  if (!p.roles || typeof p.roles !== 'object') throw new Error('policy: roles must be an object')
  for (const [name, r] of Object.entries(p.roles)) {
    if (typeof r.rank !== 'number') throw new Error(`policy: role ${name} needs a numeric rank`)
    if (!r.categories || typeof r.categories !== 'object') throw new Error(`policy: role ${name} needs categories`)
  }
  for (const [name, c] of Object.entries(p.categories ?? {})) {
    if (!Array.isArray(c.tools)) throw new Error(`policy: category ${name} needs a tools array`)
  }
}

export function roleDef(p: Policy, role: string | null): { name: string; def: RoleDef } {
  if (role && p.roles[role]) return { name: role, def: p.roles[role]! }
  return { name: NONE_ROLE, def: p.roles[NONE_ROLE] ?? { rank: 0, categories: { '*': 'deny' } } }
}

export function rankOf(p: Policy, role: string | null): number {
  return roleDef(p, role).def.rank
}

/** The lower of two roles (by rank). Unknown roles count as `none`. */
export function minRole(p: Policy, a: string | null, b: string | null): string {
  const ra = roleDef(p, a), rb = roleDef(p, b)
  return ra.def.rank <= rb.def.rank ? ra.name : rb.name
}

function toolGlob(pattern: string): RegExp {
  return new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
}

/** First category (in file order) whose globs match the tool name, else '*'. */
export function categoryOf(p: Policy, tool: string): string {
  for (const [name, c] of Object.entries(p.categories)) {
    if (c.tools.some(t => toolGlob(t).test(tool))) return name
  }
  return '*'
}

export type EvalContext = {
  role: string | null
  owner: boolean
  tool: string
  input: Record<string, unknown>
  cwd: string
  home: string
  env: Record<string, string | undefined>
  /** Chat ids of the request(s) this call works for. */
  requestChats: string[]
  /** Extra protected paths (state dir, the hook's own install). */
  extraProtected?: string[]
}

export type Verdict = {
  allow: boolean
  reason: string
  category: string
  role: string
  escalatable: boolean
}

const FILE_READ = new Set(['Read', 'Glob', 'Grep', 'NotebookRead', 'LS'])
const FILE_WRITE = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const SHELL = new Set(['Bash', 'Monitor', 'PowerShell'])

function inputPaths(tool: string, input: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const k of ['file_path', 'path', 'notebook_path']) {
    const v = input[k]
    if (typeof v === 'string' && v) out.push(v)
  }
  if (tool === 'Glob' && typeof input.pattern === 'string' && /^([a-zA-Z]:)?[\\/~]/.test(input.pattern)) out.push(input.pattern.replace(/[*?[].*$/, '') || '/')
  return out
}

function shellCtx(p: Policy, c: EvalContext): ShellContext {
  return {
    cwd: c.cwd,
    home: c.home,
    env: c.env,
    sharedBranches: p.sharedBranches,
    worktreeRoots: p.worktreeRoots,
    secretPaths: p.secretPaths,
    secretPathExceptions: p.secretPathExceptions,
    secretEnvPattern: p.secretEnv.pattern,
    secretEnvAllow: p.secretEnv.allow,
  }
}

export function evaluate(p: Policy, c: EvalContext): Verdict {
  const { name: role, def } = roleDef(p, c.role)
  const category = categoryOf(p, c.tool)
  const decision: CategoryDecision = def.categories[category] ?? def.categories['*'] ?? 'deny'
  const catEscalate = p.categories[category]?.escalate !== false
  const v = (allow: boolean, reason: string, escalatable = !!def.escalate && catEscalate): Verdict => ({
    allow, reason, category, role, escalatable: allow ? false : escalatable,
  })
  const protectedList = [...p.protectedPaths, ...(c.extraProtected ?? [])]

  // Guards for every role, the board and the owner included: access control
  // changes only from the terminal, never because of a Discord message.
  if (FILE_WRITE.has(c.tool)) {
    for (const path of inputPaths(c.tool, c.input)) {
      if (matchesAny(normalizePath(path, c.cwd, c.home), protectedList, c.home)) {
        return v(false, `writing ${path} is not allowed from a Discord request: access control and settings change only from the terminal`, false)
      }
    }
  }
  if (SHELL.has(c.tool)) {
    const cmd = String(c.input.command ?? '')
    const hit = p.protectedShellWords.find(w => cmd.toLowerCase().includes(w.toLowerCase()))
    if (hit) return v(false, `the command mentions "${hit}": access control and settings change only from the terminal`, false)
  }

  switch (decision) {
    case 'deny':
      return v(false, `${category === '*' ? `tool ${c.tool}` : `"${category}"`} is not allowed for role ${role}`)
    case 'owner':
      return c.owner
        ? v(true, `"${category}" allowed for the machine owner`)
        : v(false, `"${category}" is reserved for the machine owner`, false)
    case 'worktree': {
      if (!FILE_WRITE.has(c.tool)) return v(false, `policy error: "worktree" applies only to file writes`, false)
      const paths = inputPaths(c.tool, c.input)
      if (!paths.length) return v(false, `${c.tool}: no path to check`)
      const sc = shellCtx(p, c)
      for (const path of paths) {
        if (isSecretPath(path, sc)) return v(false, `${c.tool}: ${path} is a secret path`, false)
        if (!isIsolatedWorktree(normalizePath(path, c.cwd, c.home), sc)) {
          return v(false, `${c.tool}: role ${role} may write only inside an isolated worktree (${p.worktreeRoots.join(', ')})`)
        }
      }
      return v(true, `${c.tool} inside an isolated worktree`)
    }
    case 'allowlist': {
      if (!SHELL.has(c.tool)) return v(false, `policy error: "allowlist" applies only to shell tools`, false)
      if (c.tool === 'PowerShell') return v(false, 'PowerShell commands cannot be checked against the allowlist; use Bash')
      const cmd = c.input.command
      if (typeof cmd !== 'string' || !cmd.trim()) return v(false, `${c.tool}: no command to check`)
      const r = analyzeShell(cmd, def.shell ?? {}, shellCtx(p, c))
      return v(r.allow, r.reason)
    }
    case 'allow':
      break
    default:
      return v(false, `policy error: unknown decision "${decision}"`, false)
  }

  // Allowed category: extra guards for the narrower roles.
  if (def.ownChannelOnly && category === 'discord') {
    const chat = c.input.chat_id ?? c.input.channel
    if (typeof chat === 'string' && !c.requestChats.includes(chat)) {
      return v(false, `Discord: role ${role} may only use the channel its request came from`, false)
    }
  }
  if (def.protectSecrets && (FILE_READ.has(c.tool) || FILE_WRITE.has(c.tool))) {
    const sc = shellCtx(p, c)
    for (const path of inputPaths(c.tool, c.input)) {
      if (isSecretPath(path, sc)) return v(false, `${c.tool}: ${path} is a secret path`, false)
      if (def.readRoots?.length && !matchesAny(normalizePath(path, c.cwd, c.home), def.readRoots, c.home)) {
        return v(false, `${c.tool}: role ${role} may read only below ${def.readRoots.join(', ')}`)
      }
    }
  }
  return v(true, `"${category}" allowed for role ${role}`)
}
