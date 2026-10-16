import { describe, expect, test } from 'bun:test'
import { defaultAccess, evaluateGate, normalizeAccess, resolveRole, guildChannelAllowed, type Access } from '../lib/access'

const U = '1', V = '2', G = 'g1'

function access(extra: Partial<Access> = {}): Access {
  return { ...defaultAccess(), ...extra }
}

const deps = (mentioned = true) => ({ isMentioned: async () => mentioned, save: () => {}, now: () => 1000, newCode: () => 'abc123' })

describe('resolveRole', () => {
  const a = access({
    members: { [U]: { role: 'volunteer' } },
    guilds: { [G]: { members: { [U]: { role: 'heads' } } } },
    groups: { c1: { requireMention: true, allowFrom: [], roles: { [U]: 'board' } } },
  })
  test('channel override beats guild grant beats global role', () => {
    expect(resolveRole(a, { userId: U, guildId: G, channelKey: 'c1' })).toBe('board')
    expect(resolveRole(a, { userId: U, guildId: G, channelKey: 'c2' })).toBe('heads')
    expect(resolveRole(a, { userId: U, guildId: null, channelKey: null })).toBe('volunteer')
  })
  test('no role anywhere is null', () => {
    expect(resolveRole(a, { userId: V, guildId: G, channelKey: 'c1' })).toBeNull()
  })
})

describe('evaluateGate', () => {
  test('disabled drops everything', async () => {
    const r = await evaluateGate(access({ dmPolicy: 'disabled', allowFrom: [U], members: { [U]: { role: 'board' } } }), { senderId: U, isDM: true, channelId: 'd' }, deps())
    expect(r.action).toBe('drop')
  })

  test('allowlisted DM without role is no_role (default deny)', async () => {
    const r = await evaluateGate(access({ allowFrom: [U] }), { senderId: U, isDM: true, channelId: 'd' }, deps())
    expect(r.action).toBe('no_role')
  })

  test('pairing still issues codes for unknown DMs', async () => {
    const r = await evaluateGate(access(), { senderId: V, isDM: true, channelId: 'd' }, deps())
    expect(r).toEqual({ action: 'pair', code: 'abc123', isResend: false })
  })

  test('guild member without mention is dropped when mention required', async () => {
    const a = access({ guilds: { [G]: { members: { [U]: { role: 'heads' } } } } })
    expect((await evaluateGate(a, { senderId: U, isDM: false, channelId: 'x', guildId: G }, deps(false))).action).toBe('drop')
    expect((await evaluateGate(a, { senderId: U, isDM: false, channelId: 'x', guildId: G }, deps(true))).action).toBe('deliver')
  })

  test('--no-mention guild grant delivers without mention', async () => {
    const a = access({ guilds: { [G]: { members: { [U]: { role: 'heads', requireMention: false } } } } })
    const r = await evaluateGate(a, { senderId: U, isDM: false, channelId: 'x', guildId: G }, deps(false))
    expect(r.action).toBe('deliver')
    if (r.action === 'deliver') expect(r.requester).toMatchObject({ role: 'heads', owner: false, guildId: G, channelKey: 'x' })
  })

  test('user not granted in the guild is dropped', async () => {
    const a = access({ guilds: { [G]: { members: { [U]: { role: 'heads' } } } }, members: { [V]: { role: 'board' } } })
    expect((await evaluateGate(a, { senderId: V, isDM: false, channelId: 'x', guildId: G }, deps())).action).toBe('drop')
  })

  test('owner flag is reported separately from the role', async () => {
    const a = access({ allowFrom: [U], members: { [U]: { role: 'board' } }, owners: [U] })
    const r = await evaluateGate(a, { senderId: U, isDM: true, channelId: 'd' }, deps())
    expect(r.action === 'deliver' && r.requester.owner).toBe(true)
  })

  test('thread uses parent channel entry', async () => {
    const a = access({ groups: { parent: { requireMention: false, allowFrom: [] } }, members: { [U]: { role: 'heads' } } })
    const r = await evaluateGate(a, { senderId: U, isDM: false, channelId: 'thread', parentId: 'parent', guildId: G }, deps(false))
    expect(r.action).toBe('deliver')
  })
})

test('normalizeAccess fills new fields for upstream files', () => {
  const a = normalizeAccess({ dmPolicy: 'allowlist', allowFrom: ['1'] })
  expect(a.members).toEqual({})
  expect(a.owners).toEqual([])
  expect(a.guilds).toEqual({})
})

test('guildChannelAllowed', () => {
  const a = access({ groups: { c: { requireMention: true, allowFrom: [] } }, guilds: { [G]: { members: {} } } })
  expect(guildChannelAllowed(a, 'c', null)).toBe(true)
  expect(guildChannelAllowed(a, 'other', G)).toBe(true)
  expect(guildChannelAllowed(a, 'other', 'g2')).toBe(false)
})
