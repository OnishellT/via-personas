import { expect, mock, type TestBody, test } from 'claude-code/testing'
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
function session(on: Parameters<TestBody>[1], files: Record<string, string>) {
  const registered: { name: string; description: string }[] = []
  const logged: string[] = []
  mock.env(on, { PATH: '/opt/bin', HOME: '/home/u', TMPDIR: '/tmp' })
  on('fs.stat', (_, e) => {
    if (e.path !== '/opt/bin/pi') throw new Error('ENOENT')
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
  const argv = pi.start({ ...base, persona: 'Be brief.' }).argv
  expect(argv.slice(-2)).toEqual(['--append-system-prompt', 'Be brief.'])
  expect(pi.start(base).argv).not.toContain('--append-system-prompt')
})
