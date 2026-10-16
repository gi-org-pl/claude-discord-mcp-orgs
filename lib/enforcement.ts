/**
 * Enforcement check: is the PreToolUse hook installed?
 *
 * Without the hook, roles are only labels: the session can use every tool.
 * The channel server therefore looks for the hook in the Claude Code settings
 * it can see and, when it is missing, delivers messages from owners only
 * (with enforcement="off" in the tag) and refuses everyone else.
 *
 * It can see user settings (CLAUDE_CONFIG_DIR or ~/.claude) and, when
 * CLAUDE_PROJECT_DIR is set, the project's settings. It cannot see managed
 * policy settings or `--settings` flags; set `enforcement.requireHook` to
 * false in policy.json if the hook is installed in a place it cannot see.
 */
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export const HOOK_MARKER = 'pretooluse.ts'

export function settingsFiles(env: Record<string, string | undefined> = process.env): string[] {
  const user = env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const out = [join(user, 'settings.json'), join(user, 'settings.local.json')]
  if (env.CLAUDE_PROJECT_DIR) {
    out.push(join(env.CLAUDE_PROJECT_DIR, '.claude', 'settings.json'), join(env.CLAUDE_PROJECT_DIR, '.claude', 'settings.local.json'))
  }
  return out
}

/** True when some settings file has a PreToolUse hook for all tools running our script. */
export function hookInstalledIn(settings: unknown): boolean {
  const s = settings as { hooks?: { PreToolUse?: unknown }; disableAllHooks?: boolean } | null
  if (!s || s.disableAllHooks === true) return false
  const entries = s.hooks?.PreToolUse
  if (!Array.isArray(entries)) return false
  return entries.some((e: any) => {
    const m = e?.matcher
    const all = m === undefined || m === '' || m === '*' || m === '.*'
    return all && Array.isArray(e?.hooks) && e.hooks.some((h: any) =>
      h?.type === 'command' && typeof h.command === 'string' && h.command.toLowerCase().includes(HOOK_MARKER))
  })
}

export function hookInstalled(files: string[] = settingsFiles()): boolean {
  let found = false
  for (const f of files) {
    let parsed: any
    try { parsed = JSON.parse(readFileSync(f, 'utf8')) } catch { continue }
    // disableAllHooks anywhere switches every hook off.
    if (parsed?.disableAllHooks === true) return false
    if (hookInstalledIn(parsed)) found = true
  }
  return found
}
