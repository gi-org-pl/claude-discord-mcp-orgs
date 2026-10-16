/**
 * Narrow shell allowlist for roles that must not run arbitrary commands.
 *
 * A shell command with arbitrary content cannot be judged reliably, so this
 * analyser is deliberately strict: anything it cannot parse into plain
 * argument lists (command substitution, subshells, here-docs, redirection to
 * files, variable as program name, env assignments) is denied, and every
 * segment of a pipeline / && chain must be allowed on its own.
 */
import { existsSync, readFileSync, statSync } from 'fs'
import { join, dirname, basename } from 'path'
import { normalizePath, matchesAny } from './paths.ts'

export type Tokenized = { segments: string[][]; error?: string }

export function tokenize(cmd: string): Tokenized {
  const segments: string[][] = []
  let words: string[] = []
  let cur = ''
  let has = false // current word started (allows empty quoted strings)
  let i = 0
  const pushWord = () => {
    if (has) words.push(cur)
    cur = ''
    has = false
  }
  const endSegment = () => {
    pushWord()
    if (words.length) segments.push(words)
    words = []
  }
  const fail = (error: string): Tokenized => ({ segments, error })

  while (i < cmd.length) {
    const c = cmd[i]!
    const n = cmd[i + 1]
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1)
      if (j < 0) return fail('unterminated quote')
      cur += cmd.slice(i + 1, j)
      has = true
      i = j + 1
      continue
    }
    if (c === '"') {
      i++
      has = true
      while (i < cmd.length && cmd[i] !== '"') {
        const d = cmd[i]!
        if (d === '`' || (d === '$' && cmd[i + 1] === '(')) return fail('command substitution')
        if (d === '\\' && i + 1 < cmd.length) { cur += cmd[i + 1]; i += 2; continue }
        cur += d
        i++
      }
      if (i >= cmd.length) return fail('unterminated quote')
      i++
      continue
    }
    if (c === '\\') {
      if (n === '\n') { i += 2; continue }
      if (n !== undefined) { cur += n; has = true; i += 2; continue }
      i++
      continue
    }
    if (c === '`' || (c === '$' && n === '(')) return fail('command substitution')
    if ((c === '<' || c === '>') && n === '(') return fail('process substitution')
    if (c === '(' || c === ')' || c === '{' || c === '}') {
      if (!has || c === '(' || c === ')') return fail('subshell or group')
    }
    if (c === '#' && !has) {
      while (i < cmd.length && cmd[i] !== '\n') i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') { pushWord(); i++; continue }
    if (c === '\n' || c === ';') { endSegment(); i++; continue }
    if (c === '&' && n === '&') { endSegment(); i += 2; continue }
    if (c === '|' && n === '|') { endSegment(); i += 2; continue }
    if (c === '|') { endSegment(); i += (n === '&' ? 2 : 1); continue }
    if (c === '&' && n === '>') {
      // &>target
      pushWord()
      i += 2
      if (cmd[i] === '>') i++
      const t = readRedirTarget(cmd, i)
      if (!t.ok) return fail(t.error)
      i = t.next
      continue
    }
    if (c === '&') { endSegment(); i++; continue }
    if (c === '<' || c === '>') {
      // An all-digit word right before > is a file descriptor, not an argument.
      if (/^\d+$/.test(cur) && has) { cur = ''; has = false } else pushWord()
      if (c === '<' && n === '<') return fail('here-document')
      if (c === '<') return fail('input redirection')
      i++
      if (cmd[i] === '>') i++
      if (cmd[i] === '&') {
        i++
        const m = /^\d+|^-/.exec(cmd.slice(i))
        if (!m) return fail('redirection')
        i += m[0].length
        continue
      }
      const t = readRedirTarget(cmd, i)
      if (!t.ok) return fail(t.error)
      i = t.next
      continue
    }
    cur += c
    has = true
    i++
  }
  endSegment()
  return { segments }
}

function readRedirTarget(cmd: string, i: number): { ok: true; next: number } | { ok: false; error: string } {
  while (cmd[i] === ' ' || cmd[i] === '\t') i++
  const m = /^[^\s;&|]+/.exec(cmd.slice(i))
  if (!m) return { ok: false, error: 'redirection' }
  const target = m[0].replace(/^['"]|['"]$/g, '')
  if (target !== '/dev/null' && target.toLowerCase() !== 'nul') {
    return { ok: false, error: 'redirection to a file' }
  }
  return { ok: true, next: i + m[0].length }
}

export type ShellProfile = Record<string, string>

export type ShellContext = {
  cwd: string
  home: string
  env: Record<string, string | undefined>
  sharedBranches: string[]
  worktreeRoots: string[]
  secretPaths: string[]
  secretPathExceptions: string[]
  secretEnvPattern: string
  secretEnvAllow: string[]
}

export type ShellVerdict = { allow: boolean; reason: string }

const ok = (reason = 'allowed'): ShellVerdict => ({ allow: true, reason })
const no = (reason: string): ShellVerdict => ({ allow: false, reason })

const READ_UTILS = new Set([
  'ls', 'pwd', 'echo', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'sort', 'uniq', 'cut', 'tr',
  'jq', 'find', 'diff', 'which', 'basename', 'dirname', 'realpath', 'tree', 'date', 'true', 'test',
])
const PATH_ARG_UTILS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'diff', 'tree', 'sort', 'cut', 'jq', 'uniq'])
const PKG = new Set(['bun', 'bunx', 'npm', 'npx', 'pnpm', 'yarn', 'node', 'tsc', 'vitest', 'jest', 'pytest', 'python', 'python3', 'deno'])

export function programName(argv0: string): string {
  return basename(argv0.replace(/\\/g, '/')).toLowerCase().replace(/\.(exe|cmd|bat)$/, '')
}

export function analyzeShell(command: string, profile: ShellProfile, ctx: ShellContext): ShellVerdict {
  const t = tokenize(command)
  if (t.error) return no(`shell: ${t.error} is not allowed for this role`)
  if (t.segments.length === 0) return no('shell: empty command')
  let cwd = ctx.cwd
  for (const argv of t.segments) {
    const raw = argv[0]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) return no('shell: environment assignments are not allowed for this role')
    if (raw.includes('$')) return no('shell: a variable as program name is not allowed')
    const prog = programName(raw)
    if (prog === 'cd') {
      cwd = normalizePath(argv[1] ?? ctx.home, cwd, ctx.home)
      continue
    }
    let v: ShellVerdict
    if (prog === 'git') v = profile.git ? analyzeGit(argv, profile.git, { ...ctx, cwd }) : no('shell: git is not allowed for this role')
    else if (prog === 'gh') v = profile.gh ? analyzeGh(argv, profile.gh) : no('shell: gh is not allowed for this role')
    else if (PKG.has(prog)) v = profile.packageManagers === 'worktree' ? analyzePackage(argv, prog, { ...ctx, cwd }) : no(`shell: ${prog} (running code) is not allowed for this role`)
    else if (READ_UTILS.has(prog)) v = profile.utilities === 'read' ? analyzeUtil(argv, prog, { ...ctx, cwd }) : no(`shell: ${prog} is not allowed for this role`)
    else v = no(`shell: program "${prog}" is not on the allowlist for this role`)
    if (!v.allow) return v
  }
  return ok('shell: every segment is on the allowlist')
}

function analyzeUtil(argv: string[], prog: string, ctx: ShellContext): ShellVerdict {
  if (prog === 'find' && argv.some(a => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a))) {
    return no('shell: find with -exec/-delete/-fprint is not allowed')
  }
  if (PATH_ARG_UTILS.has(prog)) {
    for (const a of argv.slice(1)) {
      if (a.startsWith('-')) continue
      if (isSecretPath(a, ctx)) return no(`shell: ${prog} on a secret path is not allowed`)
    }
  }
  return ok()
}

export function isSecretPath(p: string, ctx: Pick<ShellContext, 'cwd' | 'home' | 'secretPaths' | 'secretPathExceptions'>): boolean {
  const abs = normalizePath(p, ctx.cwd, ctx.home)
  if (matchesAny(abs, ctx.secretPathExceptions, ctx.home)) return false
  return matchesAny(abs, ctx.secretPaths, ctx.home)
}

export function isIsolatedWorktree(cwd: string, ctx: Pick<ShellContext, 'home' | 'worktreeRoots'>): boolean {
  const abs = normalizePath(cwd, cwd, ctx.home)
  return matchesAny(abs, ctx.worktreeRoots, ctx.home)
}

export function secretEnvNames(ctx: Pick<ShellContext, 'env' | 'secretEnvPattern' | 'secretEnvAllow'>): string[] {
  const re = new RegExp(ctx.secretEnvPattern, 'i')
  const allow = new Set(ctx.secretEnvAllow.map(s => s.toUpperCase()))
  return Object.keys(ctx.env).filter(k => ctx.env[k] && re.test(k) && !allow.has(k.toUpperCase())).sort()
}

/** Find the top of the work tree and read its current branch without spawning git. */
export function currentBranch(cwd: string): string | null {
  let dir = cwd
  for (let depth = 0; depth < 64; depth++) {
    const dotgit = join(dir, '.git')
    try {
      let gitDir = dotgit
      if (statSync(dotgit).isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, 'utf8'))
        if (!m) return null
        gitDir = m[1]!.trim()
        if (!/^([a-zA-Z]:)?[\\/]/.test(gitDir)) gitDir = join(dir, gitDir)
      }
      const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
      const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
      return ref ? ref[1]! : null // detached HEAD -> unknown
    } catch {}
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
  return null
}

function worktreeTop(cwd: string): string | null {
  let dir = cwd
  for (let depth = 0; depth < 64; depth++) {
    if (existsSync(join(dir, '.git'))) return dir
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
  return null
}

export function isShared(branch: string, shared: string[]): boolean {
  const b = branch.replace(/^refs\/heads\//, '')
  return shared.some(p => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i').test(b))
}

const GIT_READ = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'ls-files', 'ls-tree', 'ls-remote', 'rev-parse', 'rev-list',
  'describe', 'shortlog', 'grep', 'cat-file', 'merge-base', 'fetch', 'show-ref', 'for-each-ref',
  'name-rev', 'whatchanged', 'count-objects', 'version', 'help', 'check-ignore', 'reflog', 'branch',
  'tag', 'remote', 'worktree', 'stash', 'config',
])
const GIT_WRITE = new Set([
  ...GIT_READ, 'add', 'commit', 'checkout', 'switch', 'restore', 'merge', 'rebase', 'cherry-pick',
  'revert', 'push', 'pull', 'clone', 'init', 'reset', 'clean', 'mv', 'rm', 'apply', 'am',
  'format-patch', 'notes', 'submodule', 'sparse-checkout', 'lfs', 'bisect', 'range-diff',
])
const GIT_EXEC_OPTS = /^--?(upload-pack|receive-pack|exec|template|config)(=|$)/
const GIT_CONFIG_ALLOWED_KEYS = /^(user\.(name|email)|pull\.rebase|push\.autosetupremote|init\.defaultbranch|branch\..+\.(remote|merge|rebase)|remote\..+\.(url|fetch|pushurl))$/i

export function analyzeGit(argv: string[], level: string, ctx: ShellContext): ShellVerdict {
  let i = 1
  let cwd = ctx.cwd
  while (i < argv.length && argv[i]!.startsWith('-')) {
    const g = argv[i]!
    if (g === '-C') { cwd = normalizePath(argv[i + 1] ?? '.', cwd, ctx.home); i += 2; continue }
    if (g === '--no-pager' || g === '--no-optional-locks' || g === '-P' || g === '--paginate' || g === '-p') { i++; continue }
    return no(`git: global option ${g} is not allowed for this role`)
  }
  const sub = argv[i]
  const args = argv.slice(i + 1)
  if (!sub) return ok()
  const subL = sub.toLowerCase()
  const allowed = level === 'write' ? GIT_WRITE : GIT_READ
  if (!allowed.has(subL)) return no(`git: "${sub}" is not allowed for this role (${level === 'write' ? 'unknown subcommands and aliases are denied' : 'read-only git'})`)
  if (args.some(a => GIT_EXEC_OPTS.test(a))) return no(`git ${sub}: options that run commands or set config are not allowed`)
  if (['clone', 'fetch', 'pull', 'ls-remote', 'archive'].includes(subL) && args.some(a => a === '-u' || (subL === 'clone' && a === '-c'))) return no(`git ${sub}: options that run commands or set config are not allowed`)
  const flags = args.filter(a => a.startsWith('-'))
  const positional = args.filter(a => !a.startsWith('-'))
  const has = (...names: string[]) => flags.some(f => names.includes(f) || names.some(n => n.startsWith('--') && f.startsWith(n + '=')))
  const shortHas = (ch: string) => flags.some(f => /^-[a-zA-Z]+$/.test(f) && f.includes(ch))

  // Read-only level: subcommands that can also write must be in their listing form.
  if (level !== 'write') {
    switch (subL) {
      case 'branch':
        if (has('-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force', '-u', '--set-upstream-to', '--unset-upstream', '--edit-description')) return no('git branch: only listing is allowed for this role')
        if (positional.length && !has('--list', '-l', '--contains', '--merged', '--no-merged', '--points-at')) return no('git branch: only listing is allowed for this role')
        return ok()
      case 'tag':
        if (positional.length && !has('-l', '--list', '--contains', '--merged', '--points-at')) return no('git tag: only listing is allowed for this role')
        if (has('-d', '--delete', '-a', '-s', '-f', '--force')) return no('git tag: only listing is allowed for this role')
        return ok()
      case 'remote':
        if (positional.length && positional[0] !== 'show' && positional[0] !== 'get-url') return no('git remote: only listing is allowed for this role')
        return ok()
      case 'worktree':
        return positional[0] === 'list' ? ok() : no('git worktree: only listing is allowed for this role')
      case 'stash':
        return positional[0] === 'list' || positional[0] === 'show' ? ok() : no('git stash: only list/show are allowed for this role')
      case 'reflog':
        return !positional.length || positional[0] === 'show' ? ok() : no('git reflog: only show is allowed for this role')
      case 'config':
        return has('--get', '--get-all', '--get-regexp', '--list', '-l') ? ok() : no('git config: only reading is allowed for this role')
      default:
        return ok()
    }
  }

  const current = () => currentBranch(cwd)
  switch (subL) {
    case 'push': {
      if (has('--mirror', '--prune')) return no('git push: --mirror/--prune are not allowed for this role')
      const force = has('--force', '--force-with-lease', '--force-if-includes') || shortHas('f')
      const del = has('--delete') || shortHas('d')
      const refspecs = positional.slice(1)
      const plusOrColon = refspecs.some(r => r.startsWith('+') || r.startsWith(':'))
      if (!force && !del && !plusOrColon) return ok()
      if (has('--all', '--tags') && (force || del)) return no('git push: forced push of all refs is not allowed')
      let targets = refspecs.map(r => {
        const s = r.replace(/^\+/, '')
        const dst = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s
        return dst.replace(/^refs\/heads\//, '')
      }).filter(Boolean)
      if (targets.length === 0) {
        const b = current()
        if (!b) return no('git push: forced push with unknown target branch is not allowed')
        targets = [b]
      }
      const bad = targets.find(t => isShared(t, ctx.sharedBranches))
      if (bad) return no(`git push: force-push or delete on shared branch "${bad}" is not allowed`)
      return ok()
    }
    case 'reset': {
      if (!has('--hard', '--merge', '--keep')) return ok()
      const b = current()
      if (!b) return no('git reset --hard: current branch is unknown (detached?), not allowed')
      if (isShared(b, ctx.sharedBranches)) return no(`git reset --hard on shared branch "${b}" is not allowed`)
      return ok()
    }
    case 'branch': {
      const destructive = has('-d', '-D', '--delete', '-m', '-M', '--move', '-C', '-f', '--force')
      const bad = positional.find(p => isShared(p, ctx.sharedBranches))
      if (destructive && bad) return no(`git branch: deleting or overwriting shared branch "${bad}" is not allowed`)
      return ok()
    }
    case 'checkout':
    case 'switch': {
      const idx = args.findIndex(a => a === '-B' || a === '-C' || a === '--force-create')
      if (idx >= 0 && args[idx + 1] && isShared(args[idx + 1]!, ctx.sharedBranches)) return no(`git ${sub}: resetting shared branch "${args[idx + 1]}" is not allowed`)
      return ok()
    }
    case 'rebase': {
      if (has('--exec', '-x') || shortHas('x')) return no('git rebase --exec runs commands and is not allowed')
      if (positional[0] === '--continue' || has('--abort', '--continue', '--skip', '--quit')) return ok()
      const b = current()
      if (!b || isShared(b, ctx.sharedBranches)) return no(`git rebase: rewriting ${b ? `shared branch "${b}"` : 'an unknown branch'} is not allowed`)
      return ok()
    }
    case 'clean': {
      if (has('-n', '--dry-run') || shortHas('n')) return ok()
      if (!isIsolatedWorktree(cwd, ctx)) return no('git clean outside an isolated worktree is not allowed')
      return ok()
    }
    case 'config': {
      if (has('--global', '--system', '--file', '-f', '--blob')) return no('git config: only repository-local config is allowed')
      if (has('--get', '--get-all', '--get-regexp', '--list', '-l')) return ok()
      const key = positional[0]
      if (!key || !GIT_CONFIG_ALLOWED_KEYS.test(key)) return no(`git config: key "${key ?? ''}" is not on the allowlist`)
      return ok()
    }
    case 'submodule':
      return positional[0] === 'foreach' ? no('git submodule foreach runs commands and is not allowed') : ok()
    case 'bisect':
      return positional[0] === 'run' ? no('git bisect run runs commands and is not allowed') : ok()
    default:
      return ok()
  }
}

const GH_REVIEW: Record<string, string[]> = {
  pr: ['view', 'diff', 'list', 'checks', 'status', 'comment', 'review'],
  issue: ['view', 'list', 'status'],
  repo: ['view', 'list'],
  search: ['*'],
  run: ['view', 'list'],
  release: ['view', 'list'],
  label: ['list'],
  auth: ['status'],
  status: ['*'],
}
const GH_WRITE: Record<string, string[]> = {
  pr: ['view', 'diff', 'list', 'checks', 'status', 'comment', 'review', 'create', 'edit', 'checkout', 'close', 'reopen', 'ready', 'update-branch', 'lock', 'unlock'],
  issue: ['view', 'list', 'status', 'create', 'comment', 'edit', 'close', 'reopen', 'develop', 'pin', 'unpin', 'lock', 'unlock'],
  repo: ['view', 'list', 'clone', 'fork', 'sync', 'set-default'],
  search: ['*'],
  run: ['view', 'list', 'watch', 'rerun', 'cancel', 'download'],
  workflow: ['view', 'list'],
  release: ['view', 'list', 'download'],
  label: ['list', 'create', 'edit', 'clone'],
  project: ['view', 'list', 'item-list', 'item-add', 'item-edit', 'item-create', 'field-list'],
  cache: ['list'],
  auth: ['status'],
  status: ['*'],
}

export function analyzeGh(argv: string[], level: string): ShellVerdict {
  // Drop --repo/-R and its value wherever it appears.
  const a: string[] = []
  for (let i = 1; i < argv.length; i++) {
    const x = argv[i]!
    if (x === '-R' || x === '--repo') { i++; continue }
    if (x.startsWith('--repo=')) continue
    a.push(x)
  }
  if (a.some(x => x === '--web' || x === '-w')) return no('gh: --web opens a browser and is not allowed')
  const group = a[0]
  const sub = a.find((x, idx) => idx > 0 && !x.startsWith('-'))
  if (!group) return ok()
  const table = level === 'write' ? GH_WRITE : GH_REVIEW
  const subs = table[group]
  if (!subs) return no(`gh ${group}: not allowed for this role`)
  if (!subs.includes('*') && (!sub || !subs.includes(sub))) return no(`gh ${group} ${sub ?? ''}: not allowed for this role`.replace(/ +:/, ':'))
  if (group === 'pr' && sub === 'review' && level !== 'write') {
    if (a.some(x => ['--approve', '-a', '--request-changes', '-r'].includes(x))) return no('gh pr review: only --comment reviews are allowed for this role')
    if (!a.some(x => x === '--comment' || x === '-c')) return no('gh pr review: pass --comment (approvals are not allowed for this role)')
  }
  if (group === 'repo' && sub === 'sync' && a.includes('--force')) return no('gh repo sync --force is not allowed')
  return ok()
}

function analyzePackage(argv: string[], prog: string, ctx: ShellContext): ShellVerdict {
  if (!isIsolatedWorktree(ctx.cwd, ctx)) return no(`${prog}: installs and tests are allowed only inside an isolated worktree (${ctx.worktreeRoots.join(', ')})`)
  if (argv.some(x => x === '-g' || x === '--global' || x === '--location=global')) return no(`${prog}: global installs are not allowed`)
  const sub = argv[1]
  if (sub && ['publish', 'login', 'logout', 'adduser', 'token', 'link', 'config', 'owner', 'access', 'unpublish', 'deprecate'].includes(sub)) {
    return no(`${prog} ${sub}: not allowed for this role`)
  }
  const secrets = secretEnvNames(ctx)
  if (secrets.length) return no(`${prog}: the environment holds secret-looking variables (${secrets.join(', ')}); run code only in a session without them`)
  const top = worktreeTop(ctx.cwd)
  if (top) {
    for (const f of ['.env', '.env.local', '.env.development', '.env.production']) {
      if (existsSync(join(top, f))) return no(`${prog}: the worktree contains ${f}; remove secrets before running code`)
    }
  }
  return ok()
}
