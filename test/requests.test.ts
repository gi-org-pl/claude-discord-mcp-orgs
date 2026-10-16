import { describe, expect, test } from 'bun:test'
import { checkLimits, emptyState, endRequest, isActive, marker, markersIn, newRequestId, prune, scrubRequestIds, type RequestRecord } from '../lib/requests'

const H = 3_600_000
function rec(id: string, user: string, created_at: number, extra: Partial<RequestRecord> = {}): RequestRecord {
  return { id, requester_id: user, role: 'heads', owner: false, chat_id: 'c', message_id: 'm', guild_id: null, channel_key: null, created_at, ...extra }
}

describe('ids and markers', () => {
  test('ids are random and match the marker pattern', () => {
    const a = newRequestId(), b = newRequestId()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^dr_[0-9a-f]{16}$/)
    expect(markersIn(`do it ${marker(a)} and ${marker(a)} ${marker(b)}`)).toEqual([a, b])
    expect(markersIn('[discord-request: dr_123]')).toEqual([])
  })
  test('scrub removes ids from outbound text', () => {
    expect(scrubRequestIds('done dr_0123456789abcdef!')).toBe('done [request]!')
  })
})

describe('limits', () => {
  const now = Date.parse('2026-05-05T12:00:00Z')
  test('concurrency counts only active, unended requests', () => {
    const s = emptyState()
    s.requests.a = rec('a', 'u', now - 1000)
    s.requests.b = rec('b', 'u', now - 2000, { ended_at: now - 500 })
    s.requests.c = rec('c', 'u', now - 10 * H) // expired
    expect(checkLimits(s, 'u', { maxConcurrent: 2 }, now, 360).ok).toBe(true)
    s.requests.d = rec('d', 'u', now - 100)
    expect(checkLimits(s, 'u', { maxConcurrent: 2 }, now, 360)).toEqual({ ok: false, reason: 'concurrent limit 2 reached' })
    expect(checkLimits(s, 'other', { maxConcurrent: 2 }, now, 360).ok).toBe(true)
  })
  test('daily count is per UTC day', () => {
    const s = emptyState()
    s.requests.y = rec('y', 'u', now - 24 * H)
    s.requests.a = rec('a', 'u', now - H, { ended_at: now })
    expect(checkLimits(s, 'u', { dailyRequests: 2 }, now, 360).ok).toBe(true)
    s.requests.b = rec('b', 'u', now - H, { ended_at: now })
    expect(checkLimits(s, 'u', { dailyRequests: 2 }, now, 360).ok).toBe(false)
  })
  test('missing or zero = unlimited', () => {
    const s = emptyState()
    for (let i = 0; i < 50; i++) s.requests[`r${i}`] = rec(`r${i}`, 'u', now)
    expect(checkLimits(s, 'u', {}, now, 360).ok).toBe(true)
    expect(checkLimits(s, 'u', undefined, now, 360).ok).toBe(true)
  })
})

test('end, active and prune', () => {
  const now = 1_000_000_000
  const s = emptyState()
  s.requests.a = rec('a', 'u', now)
  s.requests.old = rec('old', 'u', now - 40 * 24 * H)
  expect(isActive(s.requests.a!, now, 60)).toBe(true)
  expect(endRequest(s, 'a', now)).toBe(true)
  expect(endRequest(s, 'a', now)).toBe(false)
  expect(isActive(s.requests.a!, now, 60)).toBe(false)
  prune(s, now, 30)
  expect(Object.keys(s.requests)).toEqual(['a'])
})
