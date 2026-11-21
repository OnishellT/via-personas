import { expect, mock, type TestBody, test } from 'claude-code/testing'
import { agentInfo, agentStore, ROOT, runTurn, STEP } from '../helpers'

type TestOn = Parameters<TestBody>[1]
type Spawn = { argv: string[]; input: string | undefined; env?: Record<string, string> }

const SID = '35e29d23-c849-4fb0-9f57-ff89defba54e'
const TOOL = 'call-f54493f3-bed1-4538-94bb-42201ff93a3b-0\nfc_65b9bde5-9708-4298-8daf-e6e67e62bcf8_0'
const chunk = (text: string) => ({ sessionId: SID, update: { content: { text, type: 'text' }, sessionUpdate: 'agent_message_chunk' } })
// Captured from relay/relay.mjs over `cursor-agent acp` (2026.11.19, 2026-11-21), compacted: the model's message
// chunks joined, its thought chunks and slash-command list dropped. Cursor names a tool by its kind ("Terminal")
// and gives the command only in the update after the first.
const CAPTURED = [
  { relay: 'session', sessionId: SID, cwd: '/w' },
  { relay: 'model', name: 'default[]' },
  { relay: 'steered' },
  chunk("I'll list the files in this folder now."),
  {
    sessionId: SID,
    update: { toolCallId: TOOL, title: 'Terminal', kind: 'execute', status: 'pending', rawInput: {}, sessionUpdate: 'tool_call' },
  },
  {
    sessionId: SID,
    update: {
      toolCallId: TOOL,
      title: '`ls -la /w`',
      rawInput: { command: 'ls -la /w' },
      sessionUpdate: 'tool_call_update',
    },
  },
  { sessionId: SID, update: { toolCallId: TOOL, status: 'in_progress', sessionUpdate: 'tool_call_update' } },
  {
    sessionId: SID,
    update: {
      toolCallId: TOOL,
      status: 'completed',
      rawOutput: { exitCode: 0, stdout: 'total 16\n-rw-r--r-- 1 dev dev  36 Nov 21 03:28 fruit.csv\n', stderr: '' },
      sessionUpdate: 'tool_call_update',
    },
  },
  chunk('This folder contains `fruit.csv`.'),
  { relay: 'prompt_done', stopReason: 'end_turn', usage: null },
  { relay: 'done', stopReason: 'end_turn' },
]
const lines = (events: unknown[]) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
const AGENT = agentInfo({ id: 'a1', description: 'x', type: 'crew:cursor' })

function arrange(
  on: TestOn,
  spawns: Spawn[],
  out: { stdout?: string; stderr?: string; code?: number } = { stdout: lines(CAPTURED) },
  o: { mode?: string; session?: string } = {},
) {
  mock.clock(on)
  mock.env(on, { HOME: '/home/u' })
  on('agent.list', () => ({ value: [AGENT] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e, next) => next(e))
  on('session.messages', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '24.11.0\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  const records = agentStore(on, { a1: { harness: 'cursor', mode: o.mode ?? 'default', ...(o.session ? { session: o.session } : {}) } })
  on('fs.write', () => ({ value: undefined }))
  on('process.spawn', async function* (_, e) {
    spawns.push({ argv: [...e.argv], input: e.input, env: e.env })
    if (out.stdout) yield { stream: 'stdout' as const, text: out.stdout }
    if (out.stderr) yield { stream: 'stderr' as const, text: out.stderr }
    return { value: { code: out.code ?? 0, signal: null } }
  })
  return records
}

test('a cursor agent runs `cursor-agent acp` behind the relay, with its prompt on stdin', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'list the files' })
  await runTurn($)
  expect(spawns[0]?.argv).toEqual(['node', `${ROOT}/relay/relay.mjs`, '--', 'cursor-agent', 'acp'])
  expect(spawns[0]?.input).toBe('list the files')
  expect(spawns[0]?.env?.RELAY_MODEL).toBeUndefined()
})

// Cursor sends no message ids, so the relay takes all its text for one message, what it said before the command included.
test('the answer is signed with the session model; a command shows once, with its command and output', async ($, on) => {
  arrange(on, [])
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { chunks, result, calls } = await runTurn($)
  expect(result.answer).toBe("I'll list the files in this folder now.This folder contains `fruit.csv`.\n\n— answered by cursor, default[]")
  const inputs = chunks.flatMap((c) => (c.kind === 'input' ? [JSON.parse(c.json) as unknown] : []))
  expect(inputs).toEqual([{ kind: 'execute', title: '`ls -la /w`' }])
  expect(calls).toHaveLength(1)
  expect(JSON.stringify(calls)).toContain('fruit.csv')
})

test("a model line reaches cursor's model option as given, brackets included", async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'model: composer-2.5[fast=true]\ngo' })
  await runTurn($)
  expect(spawns[0]?.env?.RELAY_MODEL).toBe('composer-2.5[fast=true]')
  expect(spawns[0]?.input).toBe('go')
})

test('a thinking line is refused: cursor takes the effort inside its model value', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'thinking: high\ngo' })
  const { result } = await runTurn($)
  expect(spawns).toHaveLength(0)
  expect(result.answer).toContain('cursor takes no thinking level')
})

test('a tools line is refused: cursor has no read-only mode via can enforce', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'tools: read\nlook around' })
  const { result } = await runTurn($)
  expect(spawns).toHaveLength(0)
  expect(result.answer).toContain('cursor cannot enforce read-only tools, so a tools line is refused.')
})

test('plan mode refuses cursor, which has no read-only mode via can enforce', async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, undefined, { mode: 'plan' })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'look around' })
  const { result } = await runTurn($)
  expect(spawns).toHaveLength(0)
  expect(result.answer).toContain('cursor cannot run in plan mode')
})

test("the permission mode decides how cursor's own questions are answered, and a message can steer a running prompt", async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await runTurn($)
  expect(spawns[0]?.env?.RELAY_POLICY).toBe('ask')
  expect(spawns[0]?.env?.RELAY_STEER).toBe('prompt')
})

test("a bypass-mode run approves cursor's questions", async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, undefined, { mode: 'bypassPermissions' })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await runTurn($)
  expect(spawns[0]?.env?.RELAY_POLICY).toBe('allow')
})

test("a dontAsk run denies cursor's questions", async ($, on) => {
  const spawns: Spawn[] = []
  arrange(on, spawns, undefined, { mode: 'dontAsk' })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await runTurn($)
  expect(spawns[0]?.env?.RELAY_POLICY).toBe('deny')
})

test('the session id is saved and a follow-up resumes it through the relay', async ($, on) => {
  const spawns: Spawn[] = []
  const records = arrange(on, spawns)
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  await runTurn($)
  expect(records.record('a1')?.session).toBe(SID)
  await $.turn.start({ turnId: 't2', agentId: 'a1', text: 'and again' })
  await runTurn($, { ...STEP, turnId: 't2', messageCount: 2 })
  expect(spawns[1]?.env?.RELAY_SESSION).toBe(SID)
})

test('a lost session fails in plain words and is forgotten', async ($, on) => {
  const spawns: Spawn[] = []
  const records = arrange(
    on,
    spawns,
    {
      stdout: lines([{ relay: 'session_lost', message: 'Invalid params: Session "gone" not found' }]),
      stderr: 'acp relay: session lost: Invalid params: Session "gone" not found\n',
      code: 1,
    },
    { session: 'gone' },
  )
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: 'go' })
  const { result } = await runTurn($)
  expect(result.answer).toContain("cursor could not find this agent's earlier session")
  expect(records.record('a1')?.session).toBe('')
})
