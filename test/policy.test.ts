import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { categoryOf, defaultPolicy, evaluate, loadPolicy, minRole, type EvalContext } from '../lib/policy'

const p = defaultPolicy()
const root = mkdtempSync(join(tmpdir(), 'dmo-policy-'))
const home = join(root, 'home')
const repoDir = join(root, 'repo')
const worktree = join(root, 'repo', '.claude', 'worktrees', 'w')
mkdirSync(worktree, { recursive: true })

function ev(role: string | null, tool: string, input: Record<string, unknown> = {}, extra: Partial<EvalContext> = {}) {
  return evaluate(p, { role, owner: false, tool, input, cwd: repoDir, home, env: {}, requestChats: ['chat-1'], ...extra })
}

describe('categories', () => {
  test('first matching category wins', () => {
    expect(categoryOf(p, 'mcp__figma-bridge__delete_nodes')).toBe('figma-bridge-destructive')
    expect(categoryOf(p, 'mcp__figma-bridge__get_node')).toBe('figma-bridge')
    expect(categoryOf(p, 'mcp__claude_ai_Figma__use_figma')).toBe('figma')
    expect(categoryOf(p, 'mcp__claude_ai_Gmail__send_message')).toBe('mail')
    expect(categoryOf(p, 'mcp__claude_ai_Google_Drive__search_files')).toBe('google-workspace')
    expect(categoryOf(p, 'mcp__plugin_discord_discord__reply')).toBe('discord')
    expect(categoryOf(p, 'mcp__framer__deleteNode')).toBe('framer')
    expect(categoryOf(p, 'SomethingNew')).toBe('*')
  })
})

describe('board', () => {
  test('full access except owner-only mail', () => {
    expect(ev('board', 'mcp__claude_ai_Google_Drive__search_files').allow).toBe(true)
    expect(ev('board', 'Bash', { command: 'rm -rf build' }).allow).toBe(true)
    const mail = ev('board', 'mcp__claude_ai_Gmail__send_message')
    expect(mail.allow).toBe(false)
    expect(mail.escalatable).toBe(false)
    expect(ev('board', 'mcp__claude_ai_Gmail__send_message', {}, { owner: true }).allow).toBe(true)
  })
  test('access control files are protected even for the board', () => {
    expect(ev('board', 'Edit', { file_path: join(home, '.claude', 'settings.json') }).allow).toBe(false)
    expect(ev('board', 'Write', { file_path: join(home, '.claude', 'channels', 'discord', 'access.json') }).allow).toBe(false)
    expect(ev('board', 'Bash', { command: 'sed -i s/x/y/ ~/.claude/settings.json' }).allow).toBe(false)
  })
})

describe('heads', () => {
  test('no Drive, no mail, no Framer; figma-bridge without delete_nodes', () => {
    expect(ev('heads', 'mcp__claude_ai_Google_Docs__read_doc').allow).toBe(false)
    expect(ev('heads', 'mcp__claude_ai_Gmail__search_threads').allow).toBe(false)
    expect(ev('heads', 'mcp__framer__getProjectXml').allow).toBe(false)
    expect(ev('heads', 'mcp__figma-bridge__set_text_content').allow).toBe(true)
    const del = ev('heads', 'mcp__figma-bridge__delete_nodes')
    expect(del.allow).toBe(false)
    expect(del.escalatable).toBe(true)
  })
  test('writes only inside an isolated worktree', () => {
    expect(ev('heads', 'Edit', { file_path: join(repoDir, 'src', 'a.ts') }).allow).toBe(false)
    expect(ev('heads', 'Edit', { file_path: join(worktree, 'src', 'a.ts') }).allow).toBe(true)
    expect(ev('heads', 'Write', { file_path: join(worktree, '.env') }).allow).toBe(false)
  })
  test('reads skip secrets', () => {
    expect(ev('heads', 'Read', { file_path: join(repoDir, 'README.md') }).allow).toBe(true)
    expect(ev('heads', 'Read', { file_path: join(repoDir, '.env') }).allow).toBe(false)
    expect(ev('heads', 'Read', { file_path: join(home, '.claude', 'settings.json') }).allow).toBe(false)
  })
  test('shell goes through the allowlist; PowerShell is denied', () => {
    expect(ev('heads', 'Bash', { command: 'git status' }).allow).toBe(true)
    expect(ev('heads', 'Bash', { command: 'gh pr merge 1' }).allow).toBe(false)
    expect(ev('heads', 'PowerShell', { command: 'git status' }).allow).toBe(false)
  })
  test('Discord tools only in the request channel', () => {
    expect(ev('heads', 'mcp__plugin_discord_discord__reply', { chat_id: 'chat-1', text: 'x' }).allow).toBe(true)
    expect(ev('heads', 'mcp__plugin_discord_discord__reply', { chat_id: 'other', text: 'x' }).allow).toBe(false)
  })
  test('unknown tools default to deny, escalatable', () => {
    const r = ev('heads', 'CronCreate', { prompt: 'x' })
    expect(r.allow).toBe(false)
    expect(r.escalatable).toBe(true)
  })
})

describe('volunteer and none', () => {
  test('volunteer reads and reviews only', () => {
    expect(ev('volunteer', 'Read', { file_path: join(repoDir, 'a.ts') }).allow).toBe(true)
    expect(ev('volunteer', 'Edit', { file_path: join(worktree, 'a.ts') }).allow).toBe(false)
    expect(ev('volunteer', 'mcp__figma-bridge__get_node').allow).toBe(false)
    expect(ev('volunteer', 'WebFetch', { url: 'https://x' }).allow).toBe(false)
  })
  test('unknown role names fall back to none', () => {
    const r = ev('superuser', 'Bash', { command: 'git status' })
    expect(r.role).toBe('none')
    expect(r.allow).toBe(false)
    expect(ev(null, 'TodoWrite').allow).toBe(true)
  })
  test('minRole picks the lower rank', () => {
    expect(minRole(p, 'board', 'heads')).toBe('heads')
    expect(minRole(p, 'volunteer', 'board')).toBe('volunteer')
    expect(minRole(p, 'board', 'unknown')).toBe('none')
  })
})

describe('loadPolicy', () => {
  test('missing file = default, top-level keys replace defaults, invalid throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dmo-pol-'))
    expect(loadPolicy(join(dir, 'nope.json')).roles.board).toBeDefined()
    const f = join(dir, 'policy.json')
    writeFileSync(f, JSON.stringify({ sharedBranches: ['trunk'] }))
    const lp = loadPolicy(f)
    expect(lp.sharedBranches).toEqual(['trunk'])
    expect(lp.roles.heads).toBeDefined()
    writeFileSync(f, JSON.stringify({ roles: { x: { categories: {} } } }))
    expect(() => loadPolicy(f)).toThrow()
  })
})
