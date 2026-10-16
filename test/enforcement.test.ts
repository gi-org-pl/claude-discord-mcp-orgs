import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { hookInstalled, hookInstalledIn, settingsFiles } from '../lib/enforcement'

const hook = (matcher: string | undefined, command: string) => ({ hooks: { PreToolUse: [{ matcher, hooks: [{ type: 'command', command }] }] } })

test('hook must cover all tools and run our script', () => {
  expect(hookInstalledIn(hook('*', 'bun /x/hooks/pretooluse.ts'))).toBe(true)
  expect(hookInstalledIn(hook(undefined, 'bun C:/x/hooks/PreToolUse.ts'))).toBe(true)
  expect(hookInstalledIn(hook('Bash', 'bun /x/hooks/pretooluse.ts'))).toBe(false)
  expect(hookInstalledIn(hook('*', 'echo hi'))).toBe(false)
  expect(hookInstalledIn({ ...hook('*', 'bun /x/hooks/pretooluse.ts'), disableAllHooks: true })).toBe(false)
  expect(hookInstalledIn(null)).toBe(false)
})

test('disableAllHooks in any settings file wins', () => {
  const d = mkdtempSync(join(tmpdir(), 'dmo-enf-'))
  writeFileSync(join(d, 'a.json'), JSON.stringify(hook('*', 'bun /x/hooks/pretooluse.ts')))
  writeFileSync(join(d, 'b.json'), JSON.stringify({ disableAllHooks: true }))
  expect(hookInstalled([join(d, 'a.json'), join(d, 'missing.json')])).toBe(true)
  expect(hookInstalled([join(d, 'a.json'), join(d, 'b.json')])).toBe(false)
})

test('settings files: user dir, plus project when known', () => {
  expect(settingsFiles({ CLAUDE_CONFIG_DIR: '/c' })).toEqual([join('/c', 'settings.json'), join('/c', 'settings.local.json')])
  expect(settingsFiles({ CLAUDE_CONFIG_DIR: '/c', CLAUDE_PROJECT_DIR: '/p' })).toHaveLength(4)
})
