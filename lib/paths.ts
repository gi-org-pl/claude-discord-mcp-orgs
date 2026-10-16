/**
 * Path patterns used by the policy: secret files, protected files and
 * isolated worktree roots. Patterns are globs over absolute paths with
 * forward slashes: `**` = any number of segments, `*` = within one segment,
 * a leading `~/` = the home directory. Matching is case-insensitive, because
 * the policy must hold on Windows and macOS file systems too.
 */
import { isAbsolute, resolve } from 'path'

export function normalizePath(p: string, cwd: string, home: string): string {
  let s = p.trim()
  if (s === '~') s = home
  else if (s.startsWith('~/') || s.startsWith('~\\')) s = home + s.slice(1)
  const abs = isAbsolute(s) || /^[a-zA-Z]:[\\/]/.test(s) ? s : resolve(cwd, s)
  let out = abs.replace(/\\/g, '/')
  // Git Bash style /c/Users/... -> c:/Users/...
  const msys = /^\/([a-zA-Z])\/(.*)$/.exec(out)
  if (msys && process.platform === 'win32') out = `${msys[1]}:/${msys[2]}`
  out = out.replace(/\/+/g, '/')
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return out.toLowerCase()
}

const cache = new Map<string, RegExp>()

/** Compile a glob into a regex that matches the path itself or anything below it. */
export function globToRegex(pattern: string, home: string): RegExp {
  const key = `${home}\0${pattern}`
  const hit = cache.get(key)
  if (hit) return hit
  let p = pattern.replace(/\\/g, '/')
  if (p.startsWith('~/')) p = home.replace(/\\/g, '/') + p.slice(1)
  p = p.toLowerCase()
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!
    if (c === '*') {
      if (p[i + 1] === '*') {
        // `**/` matches zero or more directories
        if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i += 1 }
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  const out = new RegExp(`^${re}(?:/.*)?$`)
  cache.set(key, out)
  return out
}

export function matchesAny(absPath: string, patterns: string[], home: string): boolean {
  return patterns.some(p => globToRegex(p, home).test(absPath))
}
