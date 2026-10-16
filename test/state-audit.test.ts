import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readJson, writeJsonAtomic, stateDir, statePaths } from '../lib/state'
import { appendAudit, formatAudit } from '../lib/audit'

const tmp = () => mkdtempSync(join(tmpdir(), 'dmo-'))

describe('state', () => {
  test('stateDir honours DISCORD_STATE_DIR', () => {
    expect(stateDir({ DISCORD_STATE_DIR: '/x/y' })).toBe('/x/y')
    expect(stateDir({})).toContain(join('.claude', 'channels', 'discord'))
  })

  test('readJson returns fallback for a missing file and round-trips a written one', () => {
    const dir = tmp()
    const file = join(dir, 'a', 'b.json')
    expect(readJson(file, { n: 0 })).toEqual({ n: 0 })
    writeJsonAtomic(file, { n: 1 })
    expect(readJson(file, { n: 0 })).toEqual({ n: 1 })
  })

  test('statePaths lays files out under one dir', () => {
    const p = statePaths('/s')
    expect(p.access).toBe(join('/s', 'access.json'))
    expect(p.audit).toBe(join('/s', 'audit.jsonl'))
  })
})

describe('audit', () => {
  test('one entry is one JSON line with a time', () => {
    const line = formatAudit({ event: 'tool', decision: 'deny', reason: 'a\nb' }, new Date('2026-01-01T00:00:00Z'))
    expect(line.endsWith('\n')).toBe(true)
    expect(line.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(line)).toEqual({ time: '2026-01-01T00:00:00.000Z', event: 'tool', decision: 'deny', reason: 'a\nb' })
  })

  test('long fields are clipped and undefined fields dropped', () => {
    const parsed = JSON.parse(formatAudit({ event: 'x', decision: 'allow', tool: 'y'.repeat(2000), role: undefined }))
    expect(parsed.tool.length).toBeLessThan(600)
    expect('role' in parsed).toBe(false)
  })

  test('appendAudit appends lines', () => {
    const file = join(tmp(), 'audit.jsonl')
    appendAudit(file, { event: 'a', decision: 'allow' })
    appendAudit(file, { event: 'b', decision: 'deny' })
    const lines = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(lines.map(l => l.event)).toEqual(['a', 'b'])
  })
})
