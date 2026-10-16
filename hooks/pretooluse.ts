#!/usr/bin/env bun
/**
 * Claude Code PreToolUse hook: narrows every tool call to the role of the
 * Discord requester it serves. Install it yourself in settings.json (see
 * README "Installing the hook"); the plugin cannot register it.
 *
 * Reads the hook input JSON on stdin, prints a decision JSON on stdout (only
 * when denying), appends one audit line per enforced decision. Any error
 * denies the call (fail closed).
 */
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { appendAudit } from '../lib/audit.ts'
import { decide, denyOutput, installDirOf, type HookInput } from '../lib/hook.ts'
import { stateDir, statePaths } from '../lib/state.ts'

export async function main(raw: string, env: Record<string, string | undefined> = process.env): Promise<string> {
  const dir = stateDir(env)
  let input: HookInput
  try {
    input = JSON.parse(raw) as HookInput
    if (!input || typeof input.tool_name !== 'string') throw new Error('no tool_name')
  } catch (err) {
    return JSON.stringify(denyOutput(`hook could not read its input (${err}); denying to stay safe`))
  }
  try {
    const result = decide(input, {
      stateDir: dir,
      env,
      // os.homedir(), not $HOME: Git Bash sets HOME=/c/Users/..., which would not match native paths.
      home: homedir(),
      now: Date.now(),
      installDir: installDirOf(fileURLToPath(import.meta.url)),
    })
    if (result.audit) appendAudit(statePaths(dir).audit, result.audit)
    return result.output ? JSON.stringify(result.output) : ''
  } catch (err) {
    appendAudit(statePaths(dir).audit, {
      event: 'tool', session_id: input.session_id, agent_id: input.agent_id, tool: input.tool_name,
      decision: 'deny', reason: `hook error: ${err}`,
    })
    return JSON.stringify(denyOutput(`hook error (${err}); denying to stay safe`))
  }
}

if (import.meta.main) {
  const raw = await Bun.stdin.text()
  const out = await main(raw)
  if (out) process.stdout.write(out + '\n')
  process.exit(0)
}
