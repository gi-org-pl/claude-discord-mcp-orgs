/**
 * Shared on-disk state helpers used by both the channel server and the
 * PreToolUse hook. Both processes run on the same machine and agree on one
 * state directory (DISCORD_STATE_DIR, default ~/.claude/channels/discord).
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'

export function stateDir(env: Record<string, string | undefined> = process.env): string {
  return env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')
}

export type StatePaths = {
  dir: string
  access: string
  policy: string
  requests: string
  audit: string
  escalations: string
  hookCache: string
}

export function statePaths(dir: string): StatePaths {
  return {
    dir,
    access: join(dir, 'access.json'),
    policy: join(dir, 'policy.json'),
    requests: join(dir, 'requests.json'),
    audit: join(dir, 'audit.jsonl'),
    escalations: join(dir, 'escalations'),
    hookCache: join(dir, 'hook-cache'),
  }
}

/** Read and parse a JSON file. Missing file returns the fallback; a corrupt one throws. */
export function readJson<T>(file: string, fallback: T): T {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw err
  }
  return JSON.parse(raw) as T
}

/** Write JSON atomically (tmp file + rename) so a concurrent reader never sees half a file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}
