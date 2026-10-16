/**
 * Drives server.ts end to end with mocked discord.js and MCP transport.
 * One import per file: server.ts is a module with side effects.
 */
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { installFakes, fakes, fakeMessage, fakeButton, FakeChannel, ChannelType } from './fakes'
import { escalate, readEscalation } from '../lib/escalations'

const dir = mkdtempSync(join(tmpdir(), 'dmo-server-'))
process.env.DISCORD_STATE_DIR = dir
process.env.DISCORD_BOT_TOKEN = 'test-token-not-real'
process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude-config')

const BOARD = '100000000000000001'
const HEADS = '100000000000000002'
const NOBODY = '100000000000000009'
const GUILD = '900000000000000001'

function writeAccess(extra: Record<string, unknown> = {}) {
  writeFileSync(join(dir, 'access.json'), JSON.stringify({
    dmPolicy: 'allowlist',
    allowFrom: [BOARD, NOBODY],
    groups: {},
    pending: {},
    members: { [BOARD]: { role: 'board' } },
    owners: [BOARD],
    guilds: { [GUILD]: { members: { [HEADS]: { role: 'heads', requireMention: true }, [NOBODY]: {} } } },
    ...extra,
  }))
}

let server: any

function inbound() {
  return fakes.mcp!.notifications.filter(n => n.method === 'notifications/claude/channel')
}

beforeAll(async () => {
  installFakes()
  writeAccess()
  server = await import('../server.ts')
})

beforeEach(() => {
  fakes.mcp!.notifications.length = 0
  writeAccess()
  for (const f of ['audit.jsonl', 'requests.json']) if (existsSync(join(dir, f))) rmSync(join(dir, f))
})

describe('inbound gate with roles', () => {
  test('a board DM is delivered with role and owner in meta', async () => {
    const dm = new FakeChannel('dm-1', ChannelType.DM, null, null, BOARD)
    await fakes.client!.emit('messageCreate', fakeMessage({ author: BOARD, channel: dm }))
    const n = inbound()
    expect(n).toHaveLength(1)
    expect(n[0].params.meta.role).toBe('board')
    expect(n[0].params.meta.owner).toBe('true')
    expect(n[0].params.meta.user_id).toBe(BOARD)
  })

  test('a guild grant covers a channel that has no per-channel entry', async () => {
    const ch = new FakeChannel('new-channel', ChannelType.GuildText, GUILD)
    await fakes.client!.emit('messageCreate', fakeMessage({ author: HEADS, channel: ch, mentioned: true }))
    expect(inbound()).toHaveLength(1)
    expect(inbound()[0].params.meta.role).toBe('heads')
    expect(inbound()[0].params.meta.owner).toBeUndefined()
  })

  test('a guild grant still requires a mention by default', async () => {
    const ch = new FakeChannel('c2', ChannelType.GuildText, GUILD)
    await fakes.client!.emit('messageCreate', fakeMessage({ author: HEADS, channel: ch, mentioned: false }))
    expect(inbound()).toHaveLength(0)
  })

  test('threads inherit the guild grant', async () => {
    const th = new FakeChannel('thread-1', ChannelType.PublicThread, GUILD, 'parent-1')
    await fakes.client!.emit('messageCreate', fakeMessage({ author: HEADS, channel: th, mentioned: true }))
    expect(inbound()).toHaveLength(1)
    expect(inbound()[0].params.meta.chat_id).toBe('thread-1')
  })

  test('a per-channel entry overrides the guild rule', async () => {
    writeAccess({ groups: { locked: { requireMention: false, allowFrom: [BOARD] } } })
    const ch = new FakeChannel('locked', ChannelType.GuildText, GUILD)
    await fakes.client!.emit('messageCreate', fakeMessage({ author: HEADS, channel: ch, mentioned: true }))
    expect(inbound()).toHaveLength(0)
  })

  test('no role = not delivered, one notice, audited', async () => {
    const dm = new FakeChannel('dm-9', ChannelType.DM, null, null, NOBODY)
    const m1 = fakeMessage({ author: NOBODY, channel: dm })
    const m2 = fakeMessage({ author: NOBODY, channel: dm })
    await fakes.client!.emit('messageCreate', m1)
    await fakes.client!.emit('messageCreate', m2)
    expect(inbound()).toHaveLength(0)
    expect(m1.replies).toHaveLength(1)
    expect(m2.replies).toHaveLength(0)
    const audit = readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(audit.some(a => a.decision === 'drop' && a.reason === 'no role')).toBe(true)
  })

  test('outbound reply is allowed to a channel covered only by a guild rule', async () => {
    const ch = new FakeChannel('later-channel', ChannelType.GuildText, GUILD)
    fakes.client!.channelsById.set(ch.id, ch)
    const res = await fakes.mcp!.callTool('reply', { chat_id: ch.id, text: 'hi' })
    expect(res.isError).toBeUndefined()
    expect(ch.sent).toHaveLength(1)
  })
})

describe('request binding and limits', () => {
  const reqFile = () => join(dir, 'requests.json')
  beforeEach(() => { if (existsSync(reqFile())) rmSync(reqFile()) })

  test('each delivered message gets a request id recorded with the requester', async () => {
    const dm = new FakeChannel('dm-1', ChannelType.DM, null, null, BOARD)
    await fakes.client!.emit('messageCreate', fakeMessage({ author: BOARD, channel: dm }))
    const meta = inbound()[0].params.meta
    expect(meta.request_id).toMatch(/^dr_[0-9a-f]{16}$/)
    const state = JSON.parse(readFileSync(reqFile(), 'utf8'))
    expect(state.requests[meta.request_id]).toMatchObject({ requester_id: BOARD, role: 'board', owner: true, chat_id: 'dm-1' })
  })

  test('heads concurrency limit (2) drops the third message until one ends', async () => {
    const ch = new FakeChannel('c-lim', ChannelType.GuildText, GUILD)
    for (let i = 0; i < 3; i++) await fakes.client!.emit('messageCreate', fakeMessage({ author: HEADS, channel: ch, mentioned: true }))
    expect(inbound()).toHaveLength(2)
    const res = await fakes.mcp!.callTool('end_request', { request_id: inbound()[0].params.meta.request_id })
    expect(res.content[0].text).toStartWith('ended')
    const m = fakeMessage({ author: HEADS, channel: ch, mentioned: true })
    await fakes.client!.emit('messageCreate', m)
    expect(inbound()).toHaveLength(3)
  })

  test('an unknown role name is treated as no role', async () => {
    writeAccess({ members: { [BOARD]: { role: 'superuser' } } })
    const dm = new FakeChannel('dm-1', ChannelType.DM, null, null, BOARD)
    await fakes.client!.emit('messageCreate', fakeMessage({ author: BOARD, channel: dm }))
    expect(inbound()).toHaveLength(0)
  })

  test('replies never carry request ids', async () => {
    const ch = new FakeChannel('scrub', ChannelType.GuildText, GUILD)
    fakes.client!.channelsById.set(ch.id, ch)
    await fakes.mcp!.callTool('reply', { chat_id: ch.id, text: 'id dr_0123456789abcdef here' })
    expect(ch.sent[0].content).toBe('id [request] here')
  })

  test('end_request is listed as a tool', async () => {
    const { tools } = await fakes.mcp!.listTools()
    expect(tools.map((t: any) => t.name)).toContain('end_request')
  })
})

describe('escalation', () => {
  const escDir = join(dir, 'escalations')
  function openEscalation() {
    const r = escalate(escDir, {
      request_id: 'dr_bbbbbbbbbbbbbbbb', requester_id: HEADS, role: 'heads', chat_id: 'chan-h',
      tool: 'mcp__claude_ai_Google_Drive__search_files', input: { query: 'budget' }, reason: '"google-workspace" is not allowed for role heads',
    }, Date.now())
    if (r.kind !== 'pending') throw new Error('expected pending')
    return r.esc
  }

  test('a new escalation is sent once, as buttons, to approvers only', async () => {
    const e = openEscalation()
    const before = fakes.client!.userFor(BOARD).sent.length
    server.checkEscalations()
    server.checkEscalations()
    await new Promise(r => setTimeout(r, 5))
    const sent = fakes.client!.userFor(BOARD).sent.slice(before)
    expect(sent).toHaveLength(1)
    expect(sent[0].content).toContain('Approval needed')
    expect(sent[0].components[0].components.map((b: any) => b.data.custom_id)).toEqual([`esc:allow:${e.id}`, `esc:deny:${e.id}`])
    expect(fakes.client!.userFor(HEADS).sent).toHaveLength(0)
  })

  test('only an approver may decide; the decision is recorded and reported to the session', async () => {
    const e = openEscalation()
    const byHeads = fakeButton(`esc:allow:${e.id}`, HEADS)
    await fakes.client!.emit('interactionCreate', byHeads)
    expect(byHeads.replies[0].content).toContain('Not authorized')
    expect(readEscalation(escDir, e.id)!.status).toBe('pending')

    const byBoard = fakeButton(`esc:allow:${e.id}`, BOARD)
    await fakes.client!.emit('interactionCreate', byBoard)
    const after = readEscalation(escDir, e.id)!
    expect(after).toMatchObject({ status: 'approved', decided_by: BOARD })
    expect(byBoard.updates[0].components).toEqual([])
    const n = inbound().at(-1)
    expect(n.params.meta).toMatchObject({ request_id: 'dr_bbbbbbbbbbbbbbbb', role: 'heads', escalation_id: e.id })
    const audit = readFileSync(join(dir, 'audit.jsonl'), 'utf8')
    expect(audit).toContain('"decision":"approved"')

    const again = fakeButton(`esc:deny:${e.id}`, BOARD)
    await fakes.client!.emit('interactionCreate', again)
    expect(again.replies[0].content).toContain('Already decided')
  })
})

describe('permission relay only to the owner', () => {
  const OTHER_BOARD = '100000000000000003'
  beforeEach(() => writeAccess({
    allowFrom: [BOARD, OTHER_BOARD],
    members: { [BOARD]: { role: 'board' }, [OTHER_BOARD]: { role: 'board' } },
  }))

  test('a permission prompt goes to owners only, not to other board members', async () => {
    const before = fakes.client!.userFor(BOARD).sent.length
    await fakes.mcp!.receive('notifications/claude/channel/permission_request', {
      request_id: 'abcde', tool_name: 'Bash', description: 'run x', input_preview: '{}',
    })
    await new Promise(r => setTimeout(r, 5))
    expect(fakes.client!.userFor(BOARD).sent.length).toBe(before + 1)
    expect(fakes.client!.userFor(OTHER_BOARD).sent).toHaveLength(0)
  })

  test('buttons from a non-owner are refused; from the owner they answer', async () => {
    const notOwner = fakeButton('perm:allow:abcde', OTHER_BOARD)
    await fakes.client!.emit('interactionCreate', notOwner)
    expect(notOwner.replies[0].content).toBe('Not authorized.')
    expect(fakes.mcp!.notifications.some(n => n.method === 'notifications/claude/channel/permission')).toBe(false)
    const owner = fakeButton('perm:allow:abcde', BOARD)
    await fakes.client!.emit('interactionCreate', owner)
    expect(fakes.mcp!.notifications.find(n => n.method === 'notifications/claude/channel/permission').params).toEqual({ request_id: 'abcde', behavior: 'allow' })
  })

  test('a "yes abcde" text from a non-owner is an ordinary message, not an approval', async () => {
    const dm = new FakeChannel('dm-o', ChannelType.DM, null, null, OTHER_BOARD)
    await fakes.client!.emit('messageCreate', fakeMessage({ author: OTHER_BOARD, channel: dm, content: 'yes abcde' }))
    expect(fakes.mcp!.notifications.some(n => n.method === 'notifications/claude/channel/permission')).toBe(false)
    expect(inbound()).toHaveLength(1)
    const dm2 = new FakeChannel('dm-b', ChannelType.DM, null, null, BOARD)
    await fakes.client!.emit('messageCreate', fakeMessage({ author: BOARD, channel: dm2, content: 'yes abcde' }))
    expect(fakes.mcp!.notifications.some(n => n.method === 'notifications/claude/channel/permission')).toBe(true)
  })
})
