import { expect, mock, type TestBody, test } from 'claude-code/testing'
import { agy } from '../hooks/adapters/agy'
import { codex } from '../hooks/adapters/codex'
import { cursor } from '../hooks/adapters/cursor'
import { opencode } from '../hooks/adapters/opencode'
import { pi } from '../hooks/adapters/pi'
import { parsePersona } from '../hooks/personas'
import { lines, NODE, ROOT, run, type Spawn, STEP, split } from './helpers'

const SCOUT = `---
name: scout
description: "Scout that inspects files"
harness: pi
harness-model: openrouter/kimi
tools: read, grep, find, ls
thinking: low
---
Answer briefly.

ALWAYS end with the line \`-- scout (pi persona) MARKER\`.
`

test('a persona file parses: flat frontmatter, quotes removed, the rest is the instructions', () => {
  expect(parsePersona('scout.md', SCOUT)).toEqual({
    name: 'scout',
    description: 'Scout that inspects files',
    harness: 'pi',
    model: 'openrouter/kimi',
    tools: 'read,grep,find,ls',
    thinking: 'low',
    body: 'Answer briefly.\n\nALWAYS end with the line `-- scout (pi persona) MARKER`.',
  })
  const bare = parsePersona('b.md', "---\r\nname: b\r\ndescription: 'x'\r\n---\r\nhi")
  expect(bare).toEqual({ name: 'b', description: 'x', harness: '', body: 'hi' })
})

test('a file with a bad or missing name or description is no persona, and says why', () => {
  expect(parsePersona('a.md', 'no frontmatter')).toBe('no frontmatter')
  expect(parsePersona('a.md', '---\nname: a\n')).toBe('unterminated frontmatter')
  expect(parsePersona('a.md', '---\ndescription: d\n---\nx')).toContain('missing name')
  expect(parsePersona('a.md', '---\nname: has space\ndescription: d\n---\nx')).toContain('bad or missing name')
  expect(parsePersona('a.md', '---\nname: b\ndescription: d\n---\nx')).toContain('does not match the file name')
  expect(parsePersona('a.md', '---\nname: a\n---\nx')).toBe('missing description')
})

// The folder's files by name; a session in /work/example, pi on PATH.
function session(on: Parameters<TestBody>[1], files: Record<string, string>, bins: string[] = ['pi']) {
  const registered: { name: string; description: string }[] = []
  const logged: string[] = []
  mock.env(on, { PATH: '/opt/bin', HOME: '/home/u', TMPDIR: '/tmp' })
  on('fs.stat', (_, e) => {
    if (!bins.some((bin) => e.path === `/opt/bin/${bin}`)) throw new Error('ENOENT')
    return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }
  })
  on('fs.list', (_, e) => {
    if (e.path !== '/work/example/.agents/agents') throw new Error('ENOENT')
    return { value: Object.keys(files).map((name) => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', (_, e) => {
    const file = files[e.path.split('/').at(-1) ?? '']
    if (file === undefined) throw new Error('ENOENT')
    return { value: file }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-haiku-5-5' }))
  // The model listings fail; the Node check for the step server passes.
  on('process.run', (_, e) => ({ value: e.argv[0] === 'node' ? NODE : { ...NODE, exitCode: 1, stdout: '' } }))
  on('ui.log', (_, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  on('agent.register', (_, e) => {
    registered.push({ name: e.name, description: e.description })
    return { value: { agent: `crew:${e.name}` } }
  })
  return { registered, logged }
}

test('a persona of the session folder becomes an agent type; a bad file or a harness-named persona is logged and skipped', async ($, on) => {
  const { registered, logged } = session(on, {
    'scout.md': SCOUT,
    'pi.md': '---\nname: pi\ndescription: clash\nharness: pi\n---\nx',
    'broken.md': '---\nname: broken\n---\nx',
    'claude-only.md': '---\nname: claude-only\ndescription: d\nharness: claude\n---\nx',
    'ghost.md': '---\nname: ghost\ndescription: d\nharness: cursor\n---\nx',
    'notes.txt': 'not markdown',
  })
  await $.session.start({ cwd: '/work/example', surface: null, isInteractive: false })
  expect(registered.map((r) => r.name)).toEqual(['pi', 'scout'])
  expect(registered.at(-1)?.description).toBe('Scout that inspects files (runs in pi)')
  expect(logged.some((l) => l.includes('broken.md') && l.includes('missing description'))).toBe(true)
  expect(logged.some((l) => l.includes('persona pi') && l.includes("harness's name"))).toBe(true)
  expect(logged.some((l) => l.includes('ghost') && l.includes('cursor'))).toBe(true)
  expect(logged.some((l) => l.includes('claude-only'))).toBe(false)
})

test('crew:cursor and a cursor persona are registered only when cursor-agent is on PATH', async ($, on) => {
  const files = { 'sage.md': '---\nname: sage\ndescription: Sage\nharness: cursor\n---\nAdvise.' }
  const { registered, logged } = session(on, files, ['pi', 'cursor-agent'])
  await $.session.start({ cwd: '/work/example', surface: null, isInteractive: false })
  expect(registered.map((r) => r.name)).toEqual(['pi', 'cursor', 'sage'])
  expect(registered.at(-1)?.description).toBe('Sage (runs in cursor)')
  expect(logged.some((l) => l.includes('sage'))).toBe(false)
})

test('without cursor-agent on PATH there is no crew:cursor, and a cursor persona is skipped with a log line', async ($, on) => {
  const { registered, logged } = session(on, { 'sage.md': '---\nname: sage\ndescription: Sage\nharness: cursor\n---\nAdvise.' })
  await $.session.start({ cwd: '/work/example', surface: null, isInteractive: false })
  expect(registered.map((r) => r.name)).toEqual(['pi'])
  expect(logged.some((l) => l.includes('sage') && l.includes('cursor'))).toBe(true)
})

test('a persona runs in pi with its instructions on every run, its model and tools as defaults a prompt line overrides', async ($, on) => {
  const spawns: Spawn[] = []
  const { registered } = session(on, { 'scout.md': SCOUT })
  on('agent.list', () => ({ value: [] }))
  on('fs.write', () => ({ value: undefined }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e, next) => next(e))
  on('session.messages', () => ({ value: [] }))
  on('process.spawn', async function* (_, e) {
    spawns.push({ argv: [...e.argv], input: e.input, env: e.env })
    yield* split(lines)
    return { value: { code: 0, signal: null } }
  })
  on('agent.spawn', (_, e) => ({ model: e.model ?? '', agentId: 'a1' }))
  await $.session.start({ cwd: '/work/example', surface: null, isInteractive: false })
  expect(registered.map((r) => r.name)).toContain('scout')
  const body = 'Answer briefly.\n\nALWAYS end with the line `-- scout (pi persona) MARKER`.'
  await $.agent.spawn({
    tool_use_id: 'toolu_scout',
    subagentType: 'crew:scout',
    prompt: 'list the files',
    description: 'd',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'haiku',
    background: false,
    fork: false,
  })
  await $.turn.start({ turnId: 't1', agentId: 'a1', text: '' })
  const first = await run($)
  expect(first.result.answer.endsWith('— answered by pi, openrouter/kimi')).toBe(true)
  const argv = spawns[0]?.argv ?? []
  expect(argv).toEqual([
    'pi',
    '-p',
    '--mode',
    'json',
    '--session-id',
    'pi-a1',
    '-e',
    `${ROOT}/pi-extension/inbox.ts`,
    '--model',
    'openrouter/kimi',
    '--tools',
    'read,grep,find,ls',
    '-na',
    '--thinking',
    'low',
    '--append-system-prompt',
    body,
  ])
  expect(spawns[0]?.input).toBe('list the files')
  // A follow-up keeps the persona, and a prompt line replaces a default.
  await $.turn.start({ turnId: 't2', agentId: 'a1', text: 'model: other/model\nthinking: high\nagain' })
  await run($, { ...STEP, turnId: 't2' })
  const next = spawns[1]?.argv ?? []
  expect(next).toContain('other/model')
  expect(next.slice(next.indexOf('--thinking'))).toEqual(['--thinking', 'high', '--append-system-prompt', body])
  expect(next[next.indexOf('--tools') + 1]).toBe('read,grep,find,ls')
})

test('pi gets the persona body as --append-system-prompt, and none without a persona', () => {
  const base = { choice: {}, prompt: 'go', agentId: 'a1', root: '/r', mode: 'default' as const }
  const argv = pi.start({ ...base, persona: { name: 'scout', body: 'Be brief.' } }).argv
  expect(argv.slice(-2)).toEqual(['--append-system-prompt', 'Be brief.'])
  expect(pi.start(base).argv).not.toContain('--append-system-prompt')
})

const ME = { name: 'scout', body: 'Be brief.\nEnd with MARKER.' }
const BLOCK = '<persona name="scout">\nBe brief.\nEnd with MARKER.\n</persona>\n\n'
const START = { choice: {}, prompt: 'go', agentId: 'a1', root: '/r', mode: 'default' as const }

test('opencode, agy and cursor get the persona as a block while their session has not taken it, and not once it has', () => {
  for (const adapter of [opencode, agy, cursor]) {
    expect(adapter.persona).toBe(true)
    expect(adapter.start({ ...START, persona: ME }).input).toBe(`${BLOCK}go`)
    expect(adapter.start({ ...START, persona: { ...ME, fresh: true } }).input).toBe(`${BLOCK}go`)
    expect(adapter.start({ ...START, persona: { ...ME, fresh: false }, session: 'S1' }).input).toBe('go')
    expect(adapter.start(START).input).toBe('go')
  }
})

test('codex gets the persona as developer_instructions on every run, beside the read-only guard, and no block', () => {
  const run = (extra: object) => codex.start({ ...START, installed: '/acp.js', mode: 'bypassPermissions', ...extra })
  const config = (r: { env?: Record<string, string> }) => JSON.parse(r.env?.CODEX_CONFIG ?? 'null')
  const first = run({ persona: ME })
  expect(first.input).toBe('go')
  expect(config(first)).toEqual({ developer_instructions: ME.body })
  expect(config(run({ persona: { ...ME, fresh: false }, session: 'S1' }))).toEqual({ developer_instructions: ME.body })
  expect(config(run({}))).toBeNull()
  const guarded = run({ persona: ME, choice: { tools: 'read' }, guard: { CODEX_CONFIG: '{"features":{"plugins":false}}' } })
  expect(config(guarded)).toEqual({ features: { plugins: false }, developer_instructions: ME.body })
})

// One opencode run as the relay prints it: it names the session, then answers (or exits without an answer).
const OPENCODE = (sid: string) => [
  { relay: 'session', sessionId: sid },
  { relay: 'steered' },
  { sessionId: sid, update: { content: { text: 'ok', type: 'text' }, messageId: 'm1', sessionUpdate: 'agent_message_chunk' } },
  { relay: 'prompt_done', stopReason: 'end_turn' },
  { relay: 'done', stopReason: 'end_turn' },
]
type Script = { stdout: unknown[]; code?: number; stderr?: string }
const jsonl = (rows: unknown[]) => `${rows.map((l) => JSON.stringify(l)).join('\n')}\n`

test('a persona agent in opencode gets the block until a run has opened its session with it; a generic crew:opencode never does', async ($, on) => {
  const spawns: Spawn[] = []
  const scripts: Script[] = [
    // 1: the session is named, then the harness fails before answering (a refused model): not delivered.
    { stdout: [{ relay: 'session', sessionId: 'ses_1' }], code: 1, stderr: 'acp relay: the agent refused model x\n' },
    // 2: the same session, answered: delivered. 3: a follow-up.
    { stdout: OPENCODE('ses_1') },
    { stdout: OPENCODE('ses_1') },
    // 4: the session is lost and forgotten. 5: a new session, which gets the block again. 6: a follow-up in it.
    { stdout: [{ relay: 'session_lost', message: 'Session not found' }], code: 1, stderr: 'acp relay: session lost: Session not found\n' },
    { stdout: OPENCODE('ses_2') },
    { stdout: OPENCODE('ses_2') },
    // 7: the generic agent.
    { stdout: OPENCODE('ses_3') },
  ]
  const { registered } = session(on, { 'docs.md': '---\nname: docs\ndescription: Docs\nharness: opencode\n---\nWrite docs.' }, [
    'pi',
    'opencode',
  ])
  mock.clock(on)
  const store = new Map<string, unknown>()
  on('store.get', (_, e, next) => (e.key.startsWith('agent') ? { value: store.get(e.key) } : next(e)))
  on('store.set', (_, e, next) => {
    if (!e.key.startsWith('agent')) return next(e)
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('agent.list', () => ({ value: [] }))
  on('fs.write', () => ({ value: undefined }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e, next) => next(e))
  on('session.messages', () => ({ value: [] }))
  on('process.spawn', async function* (_, e) {
    spawns.push({ argv: [...e.argv], input: e.input, env: e.env })
    const script = scripts.shift() as Script
    yield { stream: 'stdout' as const, text: jsonl(script.stdout) }
    if (script.stderr) yield { stream: 'stderr' as const, text: script.stderr }
    return { value: { code: script.code ?? 0, signal: null } }
  })
  let n = 0
  on('agent.spawn', (_, e) => ({ model: e.model ?? '', agentId: `a${++n}` }))
  await $.session.start({ cwd: '/work/example', surface: null, isInteractive: false })
  expect(registered.map((r) => r.name)).toEqual(['pi', 'opencode', 'docs'])
  const spawn = (subagentType: string, id: string) =>
    $.agent.spawn({
      tool_use_id: `toolu_${id}`,
      subagentType,
      prompt: 'task',
      description: 'd',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'haiku',
      background: false,
      fork: false,
    })
  let turn = 0
  const say = async (agentId: string, text: string) => {
    const turnId = `t${++turn}`
    await $.turn.start({ turnId, agentId, text })
    await run($, { ...STEP, turnId, agentId })
  }
  await spawn('crew:docs', 'p')
  await say('a1', '')
  await say('a1', 'again')
  await say('a1', 'third')
  await say('a1', 'lost')
  await say('a1', 'fresh')
  await say('a1', 'follow')
  await spawn('crew:opencode', 'g')
  await say('a2', '')
  const block = '<persona name="docs">\nWrite docs.\n</persona>\n\n'
  expect(spawns.map((s) => s.input)).toEqual([
    `${block}task`, // 1: failed before an answer
    `${block}again`, // 2: sent again, same session
    'third', // 3: the session has it
    'lost', // 4: the session had it, and is lost
    `${block}fresh`, // 5: a new session gets it again
    'follow', // 6
    'task', // 7: generic: no block
  ])
  expect(spawns[1]?.env?.RELAY_SESSION).toBe('ses_1')
  expect(spawns[4]?.env?.RELAY_SESSION).toBeUndefined()
  expect(spawns[5]?.env?.RELAY_SESSION).toBe('ses_2')
})

const AGY = (id: string, text: string) => [
  JSON.stringify({ event: 'init', conversation_id: id, init: { cwd: '/w' } }),
  JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: text } }),
  JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '\n' } }),
  JSON.stringify({ event: 'result', result: { status: 'SUCCESS', num_turns: 1 } }),
]

test('an agy persona agent whose conversation agy replaces gets the block with the next message, and is told so', async ($, on) => {
  const spawns: Spawn[] = []
  const outputs = [AGY('c1', 'one'), AGY('c1', 'two'), AGY('c2', 'three'), AGY('c2', 'four')]
  session(on, { 'bard.md': '---\nname: bard\ndescription: Bard\nharness: agy\n---\nRhyme.' }, ['pi', 'agy'])
  mock.clock(on)
  const store = new Map<string, unknown>()
  on('store.get', (_, e, next) => (e.key.startsWith('agent') ? { value: store.get(e.key) } : next(e)))
  on('store.set', (_, e, next) => {
    if (!e.key.startsWith('agent')) return next(e)
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('agent.list', () => ({ value: [] }))
  on('fs.write', () => ({ value: undefined }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e, next) => next(e))
  on('session.messages', () => ({ value: [] }))
  on('process.spawn', async function* (_, e) {
    spawns.push({ argv: [...e.argv], input: e.input, env: e.env })
    yield { stream: 'stdout' as const, text: `${(outputs.shift() as string[]).join('\n')}\n` }
    return { value: { code: 0, signal: null } }
  })
  on('agent.spawn', (_, e) => ({ model: e.model ?? '', agentId: 'a1' }))
  await $.session.start({ cwd: '/work/example', surface: null, isInteractive: false })
  await $.agent.spawn({
    tool_use_id: 'toolu_b',
    subagentType: 'crew:bard',
    prompt: 'task',
    description: 'd',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'haiku',
    background: false,
    fork: false,
  })
  const answers: string[] = []
  for (const [i, text] of ['', 'again', 'replaced', 'after'].entries()) {
    await $.turn.start({ turnId: `t${i}`, agentId: 'a1', text })
    answers.push((await run($, { ...STEP, turnId: `t${i}`, agentId: 'a1' })).result.answer)
  }
  const block = '<persona name="bard">\nRhyme.\n</persona>\n\n'
  expect(spawns.map((s) => s.input)).toEqual([`${block}task`, 'again', 'replaced', `${block}after`])
  expect(answers[2]).toContain("does not hold bard's instructions")
  expect(answers[3]).not.toContain('does not hold')
})
