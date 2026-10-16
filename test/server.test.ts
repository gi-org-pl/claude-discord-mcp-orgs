/**
 * Drives server.ts end to end with mocked discord.js and MCP transport.
 * One import per file: server.ts is a module with side effects.
 */
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { installFakes, fakes, fakeMessage, FakeChannel, ChannelType } from './fakes'

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

function inbound() {
  return fakes.mcp!.notifications.filter(n => n.method === 'notifications/claude/channel')
}

beforeAll(async () => {
  installFakes()
  writeAccess()
  await import('../server.ts')
})

beforeEach(() => {
  fakes.mcp!.notifications.length = 0
  writeAccess()
  if (existsSync(join(dir, 'audit.jsonl'))) rmSync(join(dir, 'audit.jsonl'))
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
