import { expect, mock, type TestBody, test } from 'claude-code/testing'

import { zcode } from '../../hooks/adapters/zcode'
import type { AgentRecord } from '../../hooks/record'
import { agentInfo, agentStore, run, runTurn, STEP } from '../helpers'

type TestOn = Parameters<TestBody>[1]
type Spawn = { argv: string[]; input: string | undefined }

// Captured from zcode 0.17.1 `-p --output-format stream-json` (2026-11-21), compacted: the plugin hook
// events, timings, schedules and cache statistics dropped; every field the adapter reads kept as captured.
const SID = 'sess_42251428-5f3e-4d82-a114-f9c6477b04cb'
const MODEL = 'deepseek/deepseek-v4.1-flash'
const ev = (type: string, payload: Record<string, unknown>, sessionId = SID) => JSON.stringify({ type, sessionId, payload })
const stream = (kind: string, payload: Record<string, unknown> = {}) => ev('model.streaming', { kind, delta: '', done: false, ...payload })
const jsonl = (rows: string[]) => `${rows.join('\n')}\n`
const call = (id: string, toolName: string, input: Record<string, unknown>) => stream('tool_call', { toolCallId: id, toolName, input })
const ended = (usage: Record<string, number>) => ev('session.updated', { stopReason: 'tool-calls', usage, modelId: MODEL })
const final = (response: string, id = SID) =>
  JSON.stringify({
    type: 'result',
    sessionId: id,
    response,
    usage: { source: 'provider', modelRequestCount: 2, inputTokens: 32408, outputTokens: 117, cacheReadTokens: 32256 },
  })

// A command that listed the folder, then the answer.
const RUN = jsonl([
  ev('turn.started', { input: 'list the files' }),
  ev('session.updated', { providerId: 'commandcode-responses', modelId: MODEL, toolCount: 39 }),
  stream('start'),
  call('c1', 'Bash', { command: 'ls', description: 'List files' }),
  ended({ inputTokens: 16147, outputTokens: 58, cacheReadTokens: 16128 }),
  ev('tool.updated', { toolCallId: 'c1', toolName: 'Bash', kind: 'started' }),
  ev('tool.updated', {
    toolCallId: 'c1',
    kind: 'result',
    result: { success: true, content: 'a.txt\nb.txt', perf: { detail: { kind: 'command', command: { exitCode: 0, name: 'ls' } } } },
  }),
  stream('start'),
  stream('reasoning_delta', { delta: 'The folder holds two files.' }),
  stream('text_start'),
  stream('text_delta', { delta: 'a.txt ' }),
  stream('text_delta', { delta: 'and b.txt' }),
  ev('session.updated', { stopReason: 'stop', usage: { inputTokens: 16261, outputTokens: 59, cacheReadTokens: 16128 }, modelId: MODEL }),
  ev('turn.completed', { response: 'a.txt and b.txt', usage: { inputTokens: 32408 } }),
  final('a.txt and b.txt'),
])
const AGENT = agentInfo({ id: 'a1', description: 'x', type: 'crew:zcode' })

function arrange(
  on: TestOn,
  spawns: Spawn[],
  // record: what the agent's record holds at the start, as an earlier turn or process left it.
  out: { stdout?: string; stderr?: string; code?: number; record?: Partial<AgentRecord> } = { stdout: RUN },
) {
  mock.clock(on)
  mock.env(on, {})
  const records = agentStore(on, { a1: { harness: 'zcode', ...out.record } })
  on('agent.list', () => ({ value: [AGENT] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e, next) => next(e))
  on('session.messages', () => ({ value: [] }))
  // Every harness checks Node first, for the step server.
  on('process.run', () => ({ value: { exitCode: 0, stdout: '26.12.1\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('process.spawn', async function* (_, e) {
    spawns.push({ argv: [...e.argv], input: e.input })
    // Cut mid-line, as a pipe does.
    for (const text of [out.stdout?.slice(0, 700), out.stdout?.slice(700)]) if (text) yield { stream: 'stdout' as const, text }
    if (out.stderr) yield { stream: 'stderr' as const, text: out.stderr }
    return { value: { code: out.code ?? 0, signal: null } }
  })
  return records
}

const NEW = ['zcode']
const flags = ['--output-format', 'stream-json']

test('a zcode agent sends its prompt as one --prompt= argument, so a leading dash or newline is text', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: '--help\n- not a flag' })
  await run($)
  expect(spawns[0]?.argv).toEqual([...NEW, '--prompt=--help\n- not a flag', ...flags])
  expect(spawns[0]?.input).toBeUndefined()
})

test("zcode's result is the last message's text, signed with the model it names; usage is the last model call's, cached reads apart", async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'list the files' })
  const { chunks, result } = await runTurn($)
  const starts = chunks.flatMap((c) => (c.kind === 'input' ? [JSON.parse(c.json)] : []))
  expect(starts).toEqual([{ kind: 'execute', title: 'ls' }])
  expect(result.answer).toBe(`a.txt and b.txt\n\n— answered by zcode, ${MODEL}`)
  expect(result.usage).toEqual({
    model: MODEL,
    input_tokens: 133,
    output_tokens: 59,
    cache_read_input_tokens: 16128,
    cache_creation_input_tokens: 0,
  })
})

test('the session id is saved, and a follow-up resumes it with --resume', async ($, on) => {
  const spawns: Spawn[] = []
  const records = arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'list the files' })
  await runTurn($)
  expect(records.record('a1')?.session).toBe(SID)
  await $.turn.start({ turnId: 't2', agentId: 'a1', text: 'and again' })
  await runTurn($, { ...STEP, turnId: 't2', messageCount: 2 })
  expect(spawns[1]?.argv).toEqual([...NEW, '--prompt=and again', ...flags, '--resume', SID])
})

test('a resumed run keeps the session it asked for', async ($, on) => {
  const spawns: Spawn[] = []
  const records = arrange(on, spawns, {
    stdout: jsonl([stream('start'), stream('text_delta', { delta: 'PINEAPPLE' }), final('PINEAPPLE')]),
    record: { session: SID },
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'what did I ask you to remember?' })
  const { result } = await run($)
  expect(spawns[0]?.argv.slice(-2)).toEqual(['--resume', SID])
  expect(result.answer).toContain('PINEAPPLE')
  expect(records.record('a1')?.session).toBe(SID)
})

test('the closing result is the answer when no text streamed, and is not said twice when it did', () => {
  const quiet = zcode.events()
  expect([final('only this'), ''].flatMap((l) => quiet(l))).toEqual([
    { k: 'session', id: SID },
    { k: 'message' },
    { k: 'text', t: 'only this' },
  ])
  const loud = zcode.events()
  const seen = [stream('start'), stream('text_delta', { delta: 'said' }), final('said')].flatMap((l) => loud(l))
  expect(seen.filter((n) => n.k === 'text')).toEqual([{ k: 'text', t: 'said' }])
})

test('a failing tool, a command that exits nonzero and a tool of another kind are rows that end as zcode reported', () => {
  const parse = zcode.events()
  const rows = [
    call('r', 'Read', { file_path: '/w/missing' }),
    ev('tool.updated', { toolCallId: 'r', kind: 'error', error: { type: 'tool_execution_failed', message: 'File does not exist.' } }),
    call('b', 'Bash', { command: 'cat /nope' }),
    ev('tool.updated', {
      toolCallId: 'b',
      kind: 'result',
      result: {
        success: true,
        content: 'Exit code 1\ncat: /nope: No such file or directory',
        perf: { detail: { command: { exitCode: 1 } } },
      },
    }),
    call('m', 'mcp__x__q', { q: 1 }),
    ev('tool.updated', { toolCallId: 'm', kind: 'result', result: { success: false, content: 'boom' } }),
  ].flatMap((l) => parse(l))
  expect(rows.filter((n) => n.k !== 'session')).toEqual([
    { k: 'call', id: 'r', kind: 'read', title: 'Read /w/missing', path: '/w/missing' },
    { k: 'called', id: 'r', output: 'File does not exist.', failed: true },
    { k: 'call', id: 'b', kind: 'execute', title: 'cat /nope' },
    { k: 'called', id: 'b', output: 'Exit code 1\ncat: /nope: No such file or directory', failed: true },
    { k: 'call', id: 'm', kind: 'other', title: 'mcp__x__q: {"q":1}' },
    { k: 'called', id: 'm', output: 'boom', failed: true },
  ])
})

test('noise that is not an event is ignored', () => {
  const parse = zcode.events()
  expect(['ZCode Built-in skipped', '{not json', '[]', '{"a":1}'].flatMap((l) => parse(l))).toEqual([])
})

test('a lost session is said, and forgotten so the next message starts a new one', async ($, on) => {
  const spawns: Spawn[] = []
  const records = arrange(on, spawns, {
    stdout: '',
    stderr: 'Error: Session not found: sess_gone (traceId: x)\n',
    code: 1,
    record: { session: 'sess_gone' },
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'continue' })
  const { result } = await run($)
  expect(result.answer).toContain("zcode could not find this agent's earlier session")
  expect(result.usage).toBeNull()
  expect(records.record('a1')?.session).toBeFalsy()
})

test('a failed run is said with the exit code and what zcode wrote, unsigned', async ($, on) => {
  arrange(on, [], { stdout: '', stderr: 'Error: not signed in\n', code: 1 })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(result.answer).toContain('zcode exited with 1.')
  expect(result.answer).toContain('not signed in')
  expect(result.usage).toBeNull()
})

test('a failed turn event is a failure in zcode words', async ($, on) => {
  arrange(on, [], { stdout: jsonl([ev('turn.failed', { error: { message: 'quota exhausted' } })]), code: 1 })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await run($)
  expect(result.answer).toBe("zcode's model call failed: quota exhausted")
})

test('zcode runs on its own default model: model, tools and thinking lines are refused', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  for (const [i, line] of ['model: x/y', 'tools: read', 'thinking: high'].entries()) {
    await $.turn.start({ turnId: `t${i}`, agentId: 'a1', text: `${line}\ngo` })
    const { result } = await run($, { ...STEP, turnId: `t${i}` })
    expect(result.answer).toContain('Invalid zcode prompt line')
  }
  expect(spawns).toHaveLength(0)
})

test('the persona block goes first on a session that has not taken it, and a generic agent gets none', () => {
  const base = { choice: {}, prompt: 'go', agentId: 'a1', root: '/r', mode: 'default' as const }
  const me = { name: 'scout', body: 'Be brief.\nEnd with MARKER.' }
  const block = '<persona name="scout">\nBe brief.\nEnd with MARKER.\n</persona>\n\n'
  expect(zcode.persona).toBe(true)
  expect(zcode.start({ ...base, persona: me }).argv).toEqual(['zcode', `--prompt=${block}go`, ...flags])
  expect(zcode.start({ ...base, persona: { ...me, fresh: false }, session: 'S1' }).argv).toEqual([
    'zcode',
    '--prompt=go',
    ...flags,
    '--resume',
    'S1',
  ])
  expect(zcode.start(base).argv).toEqual(['zcode', '--prompt=go', ...flags])
})
