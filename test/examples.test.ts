import { expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { normalizeAccess, resolveRole } from '../lib/access'
import { defaultPolicy, validatePolicy } from '../lib/policy'
import { hookInstalledIn } from '../lib/enforcement'

const ex = (f: string) => JSON.parse(readFileSync(join(import.meta.dir, '..', 'examples', f), 'utf8'))

test('example access.json parses and every member role exists in the policy', () => {
  const a = normalizeAccess(ex('foundation/access.json'))
  const p = defaultPolicy()
  for (const [id, m] of Object.entries(a.members)) expect(p.roles[m.role!]).toBeDefined()
  expect(resolveRole(a, { userId: '333333333333333333', guildId: '900000000000000000', channelKey: 'any' })).toBe('heads')
})

test('example policy override is valid', () => {
  validatePolicy({ ...defaultPolicy(), ...ex('foundation/policy-mail-for-board.json') })
})

test('example settings snippet is recognised by the enforcement check', () => {
  expect(hookInstalledIn(ex('settings-hook.json'))).toBe(true)
})
