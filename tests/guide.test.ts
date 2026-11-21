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
  expect(guideOf([], [{ name: 'scout', harness: 'pi' }])).toBe('')
})

test('a harness shows at most two models, then the count left and its own way to list them', () => {
  const guide = full()
  const line = guide.split('\n').find((l) => l.startsWith('- agy: ')) ?? ''
  expect(line).toContain('agy-1, agy-2')
  expect(line).not.toContain('agy-3')
  expect(line).toContain('+10: agy models')
  expect(guide).toContain('+10: codex debug models')
  expect(guide).toContain('+10: pi --list-models <search>')
  const few = guideOf([{ adapter: codex, models: ['gpt-6.2-sol'] }], [])
  expect(few).toContain('models gpt-6.2-sol (all: codex debug models)')
})

test('the personas are listed on one line, each with its harness', () => {
  const guide = guideOf(
    [
      { adapter: pi, models: ['m'] },
      { adapter: zcode, models: [] },
    ],
    [
      { name: 'scout', harness: 'pi' },
      { name: 'zscout', harness: 'zcode' },
    ],
  )
  expect(guide).toContain('Personas: crew:scout (pi), crew:zscout (zcode)')
  expect(guideOf([{ adapter: pi, models: ['m'] }], [])).not.toContain('Personas')
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
  expect(line('agy')).toContain('ids mostly end in a level, e.g. -low')
  expect(line('agy')).toContain('no tools line')
  expect(line('zcode')).toContain('no thinking line')
  expect(line('cursor')).toContain('no thinking line')
  expect(line('cursor')).toContain('model default[] (Auto: Cursor picks the model; more: `crew-help`)')
  expect(line('agy')).not.toContain('default ')
  expect(line('codex')).toContain('takes config:')
  expect(line('codex')).not.toContain('no tools line')
  expect(line('pi')).not.toContain('no interrupt:')
  expect(line('agy')).toContain('no interrupt:')
})

test('a harness whose settings name a default model says it once, and an other never invents one', () => {
  const guide = guideOf(
    [
      { adapter: pi, models: ['openrouter/kimi', 'openrouter/glm'], configured: 'openrouter/kimi' },
      { adapter: codex, models: ['gpt-6.2-sol', 'gpt-6.1-terra'], configured: 'gpt-6.1-terra' },
      { adapter: agy, models: ['a-low'] },
    ],
    [],
  )
  expect(guide).toContain('- pi: default openrouter/kimi; models openrouter/glm (all: pi --list-models <search>)')
  expect(guide).toContain('- codex: default gpt-6.1-terra; models gpt-6.2-sol (all: codex debug models)')
  expect(guide).not.toContain('default a-low')
  expect(guideOf([{ adapter: codex, models: [], configured: 'gpt-6.1-terra' }], [])).toContain(
    '- codex: default gpt-6.1-terra; others: codex debug models',
  )
})

test("codex's default is the model line of its config before the first table", () => {
  const pick = (text: string) => codex.configured.pick(text)
  expect(pick('model = "gpt-6.1-terra"\n[projects]\nmodel = "x"')).toBe('gpt-6.1-terra')
  expect(pick('# c\nmodel_reasoning_effort = "high"\nmodel="a-b"')).toBe('a-b')
  expect(pick('[projects]\nmodel = "x"')).toBeUndefined()
  expect(pick('')).toBeUndefined()
})

test('the guide says crew-help is a prompt, not a shell command, and every description words it so too', () => {
  expect(full()).toContain('`crew-help`: a prompt (not a shell command)')
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
    ALL.map((a) => ({ name: `${a.name}-scout`, harness: a.name })),
  )
  const pi = guide.split('\n').find((l) => l.startsWith('- pi: ')) ?? ''
  expect(pi.match(/provider\/some-long-model-name-for-pi-\d+/g)?.length).toBeLessThan(3)
  expect(pi).toContain('pi --list-models')
  // 2.3 characters a token as measured on a real session, so 1550 characters are about 670 tokens; these ids are the worst case.
  expect(guide.length).toBeLessThan(1550)
})

// A session in /work/example with the given binaries on PATH, personas on disk, models cached and zcode's settings.
function session(
  on: Parameters<TestBody>[1],
  c: { bins: string[]; files?: Record<string, string>; store?: Record<string, unknown>; zcode?: string; home?: Record<string, string> },
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
    const homed = c.home?.[e.path]
    if (homed !== undefined) return { value: homed }
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
    home: { '/home/u/.pi/agent/settings.json': '{"defaultProvider":"openrouter","defaultModel":"kimi"}' },
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
  expect(guide).toContain('- pi: default openrouter/kimi; models openrouter/glm (all: pi --list-models <search>)')
  expect(guide).toContain('- agy: default: its own pick; models gemini-4-neon-low (all: agy models)')
  expect(guide).toContain('- zcode: runs on deepseek/deepseek-v4.1-flash (no model line)')
  expect(guide).not.toContain('codex')
  expect(guide).toContain('Personas: crew:scout (pi), crew:zscout (zcode)')
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

test('a harness with no default to read says its own pick, in plain words; cursor says what its default[] is', () => {
  const guide = guideOf(
    [agy, opencode, cursor].map((adapter) => ({ adapter, models: adapter.name === 'cursor' ? [] : ['m-1'] })),
    [],
  )
  expect(guide).toContain('- agy: default: its own pick; models m-1')
  expect(guide).toContain('- opencode: default: its own pick; models m-1')
  expect(guide).toContain('- cursor: model default[] (Auto: Cursor picks the model; more: `crew-help`)')
  expect(guide).not.toContain('- cursor: default')
})
