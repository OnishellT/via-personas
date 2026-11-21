import { expect, mock, type TestBody, test } from 'claude-code/testing'
import { agy } from '../hooks/adapters/agy'
import { codex } from '../hooks/adapters/codex'
import { cursor } from '../hooks/adapters/cursor'
import { opencode } from '../hooks/adapters/opencode'
import { pi } from '../hooks/adapters/pi'
import { zcode } from '../hooks/adapters/zcode'
import { guideOf } from '../hooks/guide'
import { descriptionOf } from '../hooks/prompt'

const ALL = [pi, codex, agy, opencode, cursor, zcode]
const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`)
const full = () =>
  guideOf(
    ALL.map((adapter) => ({ adapter, models: adapter.name === 'zcode' || adapter.name === 'cursor' ? [] : ids(adapter.name, 12) })),
    [],
  )

test('the guide names only the harnesses it is given, and nothing at all when none is installed', () => {
  const some = guideOf(
    [pi, agy].map((adapter) => ({ adapter, models: ids(adapter.name, 2) })),
    [],
  )
  expect(some).toContain('- pi: ')
  expect(some).toContain('- agy: ')
  for (const gone of ['codex', 'opencode', 'cursor', 'zcode']) expect(some).not.toContain(`- ${gone}: `)
  expect(guideOf([], [{ name: 'scout', harness: 'pi', description: 'd' }])).toBe('')
})

test('a harness shows at most eight models, then the count left and its own way to list them', () => {
  const guide = full()
  const line = guide.split('\n').find((l) => l.startsWith('- agy: ')) ?? ''
  expect(line).toContain('agy-1, agy-2, agy-3, agy-4, agy-5, agy-6, agy-7, agy-8')
  expect(line).not.toContain('agy-9')
  expect(line).toContain('+4 more: agy models')
  expect(guide).toContain('+4 more: codex debug models')
  expect(guide).toContain('+4 more: pi --list-models <search>')
  const few = guideOf([{ adapter: codex, models: ['gpt-6.2-sol'] }], [])
  expect(few).toContain('models gpt-6.2-sol (all: codex debug models)')
})

test('each persona is listed with its harness and a one-line description', () => {
  const guide = guideOf(
    [
      { adapter: pi, models: ['m'] },
      { adapter: zcode, models: [] },
    ],
    [
      { name: 'scout', harness: 'pi', description: 'Scout that inspects files' },
      { name: 'zscout', harness: 'zcode', description: `Long\nmulti-line ${'x'.repeat(200)}` },
    ],
  )
  expect(guide).toContain('- crew:scout (pi): Scout that inspects files')
  const long = guide.split('\n').find((l) => l.startsWith('- crew:zscout (zcode): ')) ?? ''
  expect(long).toContain('Long multi-line x')
  expect(long.endsWith('…')).toBe(true)
  expect(long.length).toBeLessThan(100)
  expect(guideOf([{ adapter: pi, models: ['m'] }], [])).not.toContain('- crew:')
})

test('zcode shows the model its config names; with no config it says its own default and still works', () => {
  const read = (text: string | undefined) => (text === undefined ? undefined : zcode.configured.pick(text))
  expect(read('{"config":{"defaultModelSelection":{"providerId":"p","modelId":"deepseek/deepseek-v4.1-flash"}}}')).toBe(
    'deepseek/deepseek-v4.1-flash',
  )
  for (const bad of [
    '',
    'not json',
    '{}',
    '{"config":{}}',
    '{"config":{"defaultModelSelection":{"modelId":""}}}',
    '{"config":{"defaultModelSelection":{"modelId":7}}}',
  ])
    expect(read(bad)).toBeUndefined()
  const named = guideOf([{ adapter: zcode, models: [], configured: 'deepseek/deepseek-v4.1-flash' }], [])
  expect(named).toContain('- zcode: runs on deepseek/deepseek-v4.1-flash (no model line)')
  const missing = guideOf([{ adapter: zcode, models: [] }], [])
  expect(missing).toContain('- zcode: runs on its own default model (no model line)')
})

test('each harness line says what it refuses, from its adapter', () => {
  const guide = full()
  const line = (name: string) => guide.split('\n').find((l) => l.startsWith(`- ${name}: `)) ?? ''
  expect(line('agy')).toContain('thinking: low|medium|high|xhigh|max')
  expect(line('agy')).toContain('no tools line (no read-only)')
  expect(line('zcode')).toContain('no thinking line')
  expect(line('cursor')).toContain('no thinking line')
  expect(line('cursor')).toContain('model default[] is the one set in the harness; others: send it `crew-help`')
  expect(line('agy')).not.toContain('default ')
  expect(line('codex')).toContain('takes config:')
  expect(line('codex')).not.toContain('no tools line')
  expect(line('pi')).not.toContain('no interrupt:')
  expect(line('agy')).toContain('no interrupt:')
})

test('pi names the model it runs with no model line, the first of its list; the others never invent one', () => {
  const guide = guideOf(
    [
      { adapter: pi, models: ['openrouter/kimi', 'openrouter/glm'], fallback: 'openrouter/kimi' },
      { adapter: agy, models: ['a-low'] },
    ],
    [],
  )
  expect(guide).toContain('- pi: default openrouter/kimi; models openrouter/kimi, openrouter/glm')
  expect(guide).not.toContain('default a-low')
})

test('the guide says crew-help is a prompt, not a shell command, and every description words it so too', () => {
  expect(full()).toContain('`crew-help` is a prompt (not a shell command)')
  for (const adapter of ALL) expect(descriptionOf(adapter, ['m'])).toContain('(a prompt, not a shell command)')
})

test('long model ids are cut by space as well as by count, so the guide stays near 600 tokens with all six harnesses and a persona on each', () => {
  const long = (adapter: { name: string }) => ids(`provider/some-long-model-name-for-${adapter.name}`, 20)
  const guide = guideOf(
    ALL.map((adapter) => ({
      adapter,
      models: adapter.name === 'zcode' ? [] : long(adapter),
      ...(adapter.name === 'zcode' ? { configured: 'deepseek/deepseek-v4.1-flash' } : {}),
    })),
    ALL.map((a) => ({
      name: `${a.name}-scout`,
      harness: a.name,
      description: 'Scout that inspects files in the current folder, running in it',
    })),
  )
  const pi = guide.split('\n').find((l) => l.startsWith('- pi: ')) ?? ''
  expect(pi.match(/provider\/some-long-model-name-for-pi-\d+/g)?.length).toBeLessThan(8)
  expect(pi).toContain('more: pi --list-models')
  // About four characters a token: 600 tokens are 2400 characters, and these ids are the worst case.
  expect(guide.length).toBeLessThan(2700)
})

// A session in /work/example with the given binaries on PATH, personas on disk, models cached and zcode's settings.
function session(
  on: Parameters<TestBody>[1],
  c: { bins: string[]; files?: Record<string, string>; store?: Record<string, unknown>; zcode?: string },
) {
  mock.env(on, { PATH: '/opt/bin', HOME: '/home/u', TMPDIR: '/tmp' })
  on('fs.stat', (_, e) => {
    if (!c.bins.some((bin) => e.path === `/opt/bin/${bin}`)) throw new Error('ENOENT')
    return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }
  })
  on('fs.list', (_, e) => {
    if (e.path !== '/work/example/.agents/agents') throw new Error('ENOENT')
    return { value: Object.keys(c.files ?? {}).map((name) => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', (_, e) => {
    if (e.path === '/home/u/.zcode/v2/provider_config.json' && c.zcode !== undefined) return { value: c.zcode }
    const file = c.files?.[e.path.split('/').at(-1) ?? '']
    if (file === undefined) throw new Error('ENOENT')
    return { value: file }
  })
  on('store.get', (_, e) => ({ value: c.store?.[e.key] }))
  on('classic.SessionStart', () => ({}))
  const logged: string[] = []
  on('ui.log', (_, e) => {
    logged.push(e.text)
    return { value: undefined }
  })
  return logged
}
const START = { source: 'startup', cwd: '/work/example' } as const
const guideOfSession = async ($: Parameters<TestBody>[0]) => ((await $.classic.SessionStart(START)).additionalContext ?? []).join('\n---\n')

test('session start adds the guide as context for the installed harnesses only, with their cached models and the personas', async ($, on) => {
  const logged = session(on, {
    bins: ['pi', 'agy', 'zcode'],
    store: { 'models.pi': ['openrouter/kimi', 'openrouter/glm'], 'models.agy': ['gemini-4-neon-low'], 'models.codex': ['gpt-6.2-sol'] },
    zcode: '{"config":{"defaultModelSelection":{"modelId":"deepseek/deepseek-v4.1-flash"}}}',
    files: {
      'scout.md': '---\nname: scout\ndescription: Scout that inspects files\nharness: pi\n---\nAnswer.',
      'zscout.md': '---\nname: zscout\ndescription: ZCode scout\nharness: zcode\n---\nAnswer.',
      'cx.md': '---\nname: cx\ndescription: Codex scout\nharness: codex\n---\nAnswer.',
      'mine.md': '---\nname: mine\ndescription: Claude only\nharness: claude\n---\nAnswer.',
      'broken.md': '---\nname: broken\n---\nx',
    },
  })
  const guide = await guideOfSession($)
  expect(guide.match(/^- \w+: /gm)).toEqual(['- pi: ', '- agy: ', '- zcode: '])
  expect(guide).toContain('- pi: default openrouter/kimi; models openrouter/kimi, openrouter/glm (all: pi --list-models <search>)')
  expect(guide).toContain('- agy: models gemini-4-neon-low (all: agy models)')
  expect(guide).toContain('- zcode: runs on deepseek/deepseek-v4.1-flash (no model line)')
  expect(guide).not.toContain('codex')
  expect(guide).toContain('- crew:scout (pi): Scout that inspects files')
  expect(guide).toContain('- crew:zscout (zcode): ZCode scout')
  expect(guide).not.toContain('crew:cx')
  expect(guide).not.toContain('crew:mine')
  expect(guide).not.toContain('broken')
  // Building the guide says nothing: session.start reports the skipped personas.
  expect(logged).toEqual([])
})

test('with no config of zcode, or none of its files at all, the guide is still added', async ($, on) => {
  session(on, { bins: ['zcode'] })
  expect(await guideOfSession($)).toContain('- zcode: runs on its own default model (no model line)')
})

test('with no harness installed there is no guide', async ($, on) => {
  session(on, { bins: [] })
  expect(await guideOfSession($)).toBe('')
})
