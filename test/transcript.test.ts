import { expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { channelAttrs, classify, emptyScan, scanTranscript, transcriptPaths } from '../lib/transcript'

test('channel attributes come only from the leading tag', () => {
  expect(channelAttrs('<channel source="x" request_id="dr_0123456789abcdef" role="heads">\nhi request_id="dr_ffffffffffffffff"\n</channel>'))
    .toEqual({ source: 'x', request_id: 'dr_0123456789abcdef', role: 'heads' })
  expect(channelAttrs('text <channel request_id="dr_0123456789abcdef">')).toBeNull()
})

test('classify ignores tool results and task notifications', () => {
  expect(classify({ type: 'user', message: { content: [{ type: 'tool_result' }] } })).toBeNull()
  expect(classify({ type: 'user', origin: { kind: 'task-notification' }, message: { content: 'x' } })).toBeNull()
  expect(classify({ type: 'assistant', origin: { kind: 'human' } })).toBeNull()
  expect(classify({ type: 'user', origin: { kind: 'human' }, message: { content: [{ type: 'text', text: 'hi' }] } })?.kind).toBe('human')
})

test('a partial last line is read only once it is complete', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'dmo-tr-')), 't.jsonl')
  const entry = JSON.stringify({ type: 'user', origin: { kind: 'human' }, message: { content: 'x' } })
  writeFileSync(f, entry.slice(0, 10))
  let s = scanTranscript(f, emptyScan())
  expect(s.last).toBeNull()
  appendFileSync(f, entry.slice(10) + '\n')
  s = scanTranscript(f, s)
  expect(s.last?.kind).toBe('human')
})

test('transcript paths for the main thread and sub-agents', () => {
  const main = join('/p', 'proj', 'sess.jsonl')
  expect(transcriptPaths(main, 'sess').main).toBe(main)
  expect(transcriptPaths(main, 'sess', 'a1').agent).toBe(join('/p', 'proj', 'sess', 'subagents', 'agent-a1.jsonl'))
  const fromAgent = transcriptPaths(join('/p', 'proj', 'sess', 'subagents', 'agent-a1.jsonl'), 'sess', 'a1')
  expect(fromAgent.main).toBe(main)
})

test('without origin, a leading channel tag still marks a channel prompt (no fail-open)', () => {
  const p = classify({ type: 'user', message: { content: '<channel source="plugin:discord:discord" request_id="dr_0123456789abcdef">\nhi\n</channel>' } })
  expect(p).toEqual({ kind: 'channel', requestId: 'dr_0123456789abcdef', markers: [] })
  expect(classify({ type: 'user', message: { content: 'plain text without origin' } })).toBeNull()
})
