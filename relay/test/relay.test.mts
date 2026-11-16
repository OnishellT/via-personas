// The relay against a fake ACP agent (fake-agent.mts), run as via runs it: only PATH and what each test sets reach
// the relay and the agent, so nothing of the person's (a RELAY_* or FAKE_* variable of theirs) changes a result.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ClientCapabilities } from '@agentclientprotocol/sdk/unstable'
import { answer, get, type Printed, relayEvent, runRelay, sandbox, send, startRelay, updates } from './support/relay-run.mts'

const agent = ['node', new URL('./fake-agent.mts', import.meta.url).pathname]

/** Runs the relay over the fake agent with `env` to its end. */
const fake = (env: Record<string, string>, prompt = 'hi', cwd = sandbox().work) => runRelay({ agent, prompt, cwd, env })

/** What the fake agent echoes with FAKE_ECHO: the client's capabilities and the prompt's block types. */
type Echo = { readonly offered: ClientCapabilities; readonly blocks: readonly string[] }
const said = async (prompt: string, cwd?: string): Promise<Echo> =>
  JSON.parse(answer((await fake({ FAKE_ECHO: '1' }, prompt, cwd)).events)) as Echo

const errorOf = (events: readonly Printed[]) => relayEvent(events, 'error')?.message

/** A file the fake agent writes each cancel, close, mode and config option to (FAKE_LOG). */
const logFile = () => join(sandbox().root, 'log')
const logged = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [])

test("an agent's error keeps the cause its data carries, not only 'Internal error'", async () => {
  const run = await fake({})
  assert.equal(errorOf(run.events), "Internal error: You've hit your usage limit. Try again at 10:04 PM.")
  assert.equal(run.status, 1)
})

test('a refused or limit-stopped prompt is forwarded as it ended, not as a relay failure', async () => {
  for (const stop of ['refusal', 'max_tokens', 'max_turn_requests']) {
    const run = await fake({ FAKE_ECHO: '1', FAKE_STOP: stop })
    assert.equal(relayEvent(run.events, 'prompt_done')?.stopReason, stop)
    assert.equal(relayEvent(run.events, 'done')?.stopReason, stop)
    assert.equal(errorOf(run.events), undefined)
    assert.equal(run.status, 0)
  }
})

test('the relay offers streamed command output, no terminal of its own, and no plan capability', async () => {
  const { offered } = await said('hi')
  // With one, codex-acp sends a markdown plan as plan_update, which via does not draw, in place of text.
  assert.equal(get(offered, 'plan'), undefined)
  assert.equal(get(offered, '_meta', 'terminal_output_delta'), true)
  assert.equal(offered.terminal, false)
  assert.deepEqual(get(offered, 'session', 'notices'), {})
})

test('an image under the working folder goes along to an agent that takes images; a missing, fake or outside one stays text', async () => {
  const dir = sandbox().work
  const outside = sandbox().work
  const png = join(dir, 'shot.png')
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  writeFileSync(join(dir, 'fake.png'), 'not a png')
  writeFileSync(join(outside, 'secret.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const prompt = `Look at ${png}, ${join(dir, 'gone.png')}, ${join(dir, 'fake.png')}, ${join(outside, 'secret.png')} and docs${png}`
  assert.deepEqual((await said(prompt, dir)).blocks, ['text', 'image:image/png:8'])
})

test('a symlink or .. that leads out of the working folder stays text, and at most four images go along', async () => {
  // Real paths (macOS's temp folder is itself a symlink), so only the link or the .. decides.
  const dir = realpathSync(sandbox().work)
  const outside = realpathSync(sandbox().work)
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  writeFileSync(join(outside, 'secret.png'), png)
  symlinkSync(join(outside, 'secret.png'), join(dir, 'link.png'))
  mkdirSync(join(dir, 'sub'))
  // Written out, not joined: join would resolve the .. before the relay sees it.
  const outOfRoots = `${dir}/sub/../../../${outside.split('/').slice(-2).join('/')}/secret.png`
  assert.deepEqual((await said(`See ${join(dir, 'link.png')} and ${outOfRoots}`, dir)).blocks, ['text'])
  const many = [1, 2, 3, 4, 5].map((n) => {
    const path = join(dir, `${n}.png`)
    writeFileSync(path, png)
    return path
  })
  assert.equal((await said(`See ${many.join(' ')}`, dir)).blocks.length, 1 + 4)
})

test('a run that ends closes its session when the agent can close one, and only then', async () => {
  for (const close of ['1', '']) {
    const log = logFile()
    const run = await fake({ FAKE_ECHO: '1', FAKE_CLOSE: close, FAKE_LOG: log })
    assert.equal(run.status, 0)
    assert.deepEqual(logged(log), close ? ['close'] : [])
  }
})

// The agent keeps its turn past the cancel, so the run never reaches its own end: the close is the stop's.
test('a stopped run cancels the turn, then closes the session, before the kill', async () => {
  const log = logFile()
  const run = startRelay({ agent, prompt: 'hi', cwd: sandbox().work, env: { FAKE_CLOSE: '1', FAKE_HANG: 'stubborn', FAKE_LOG: log } })
  // The agent says when it holds the prompt.
  await run.until((line) => answer([line]) === 'holding')
  run.stop()
  await run.exited
  assert.deepEqual(logged(log), ['prompt', 'cancel', 'close'])
  assert.equal(relayEvent(run.events, 'done'), undefined)
})

/** A run with the fake agent offering config options, and what it ended with and set. */
const configured = async (env: Record<string, string>) => {
  const log = logFile()
  const run = await fake({ FAKE_ECHO: '1', FAKE_OPTIONS: '1', FAKE_LOG: log, ...env })
  return { status: run.status, error: errorOf(run.events), set: logged(log), events: run.events }
}
const via = (config: Record<string, string>) => configured({ RELAY_CONFIG: JSON.stringify(config) })
const person = (options: Record<string, string>, env: Record<string, string> = {}) =>
  configured({ RELAY_OPTIONS: JSON.stringify(options), ...env })
const outcome = ({ status, error, set }: Awaited<ReturnType<typeof configured>>) => ({ status, error, set })

test("a config option the session offers is set; a value it doesn't offer is refused, naming those it does", async () => {
  assert.deepEqual(outcome(await via({ reasoning_effort: 'high' })), { status: 0, error: undefined, set: ['set reasoning_effort=high'] })
  assert.deepEqual(outcome(await via({ reasoning_effort: 'ultra' })), {
    status: 1,
    error: 'the agent offers reasoning_effort low, medium, high, xhigh for gpt-6-luna, not ultra',
    set: [],
  })
})

test('a config option the session does not offer is refused, not sent', async () => {
  assert.deepEqual(outcome(await via({ speed: 'fast' })), { status: 1, error: 'the agent offers no speed option for gpt-6-luna', set: [] })
})

test("a person's config option is set when offered; one the session lacks is a warning, and the run goes on", async () => {
  assert.deepEqual(outcome(await person({ 'fast-mode': 'on' })), { status: 0, error: undefined, set: ['set fast-mode=on'] })
  const lacking = await person({ speed: 'fast' })
  assert.deepEqual(outcome(lacking), { status: 0, error: undefined, set: [] })
  const notice = updates(lacking.events).find((u) => u.sessionUpdate === 'notice')
  assert.equal(
    notice?.sessionUpdate === 'notice' ? notice.title : undefined,
    'the agent offers no speed option for gpt-6-luna, so this run goes without it; it offers fast-mode. config: speed= drops it.',
  )
  assert.equal(relayEvent(lacking.events, 'done')?.stopReason, 'end_turn')
})

test("via's mode is set again after a person's options, so one named some other way cannot leave the session in another", async () => {
  assert.deepEqual((await person({ 'fast-mode': 'on' }, { RELAY_AGENT_MODE: 'workspace-write' })).set, [
    'mode workspace-write',
    'set fast-mode=on',
    'mode workspace-write',
  ])
})

test("a person's config line sets only options that tune the model: never a mode, model or thinking one", async () => {
  for (const id of ['mode', 'model', 'reasoning_effort', 'sandbox'])
    assert.deepEqual(outcome(await person({ [id]: id === 'mode' ? 'agent-full-access' : 'off' })), {
      status: 1,
      error: `${id} is not an option a config line sets: only ones that tune the model, such as fast-mode. config: ${id}= drops it.`,
      set: [],
    })
})

test("a refused model, mode or config option keeps the agent's reason, not only 'Invalid params'", async () => {
  const refused = async (env: Record<string, string>) => {
    const run = await configured({ FAKE_REFUSE: '1', ...env })
    assert.equal(run.status, 1)
    return run.error
  }
  assert.equal(
    await refused({ RELAY_MODEL: 'gpt-6.1-sol' }),
    'the agent refused model gpt-6.1-sol: Invalid params: no model gpt-6.1-sol here; try gpt-6-luna',
  )
  assert.equal(
    await refused({ RELAY_AGENT_MODE: 'read-only' }),
    'the agent refused mode read-only: Invalid params: no mode read-only here; try workspace-write',
  )
  assert.equal(
    await refused({ RELAY_CONFIG: JSON.stringify({ reasoning_effort: 'high' }) }),
    'the agent refused reasoning_effort high: Invalid params: no reasoning_effort high here; try gpt-6-luna',
  )
})

test('a permission request is answered by RELAY_POLICY: allow picks allow_once; deny, the default, reject_once', async () => {
  assert.equal(answer((await fake({ FAKE_ASK: '1', RELAY_POLICY: 'allow' })).events), 'chose allow_once')
  assert.equal(answer((await fake({ FAKE_ASK: '1', RELAY_POLICY: 'deny' })).events), 'chose reject_once')
  assert.equal(answer((await fake({ FAKE_ASK: '1' })).events), 'chose reject_once')
})

test('with RELAY_POLICY=ask the request reaches the plugin as an ask, and its answer reaches the agent', async () => {
  const b = sandbox()
  const run = startRelay({ agent, prompt: 'hi', cwd: b.work, env: { FAKE_ASK: '1', RELAY_POLICY: 'ask', RELAY_INBOX: b.inbox } })
  await run.until((line) => relayEvent([line], 'ask') !== undefined)
  const ask = relayEvent(run.events, 'ask')
  assert.ok(ask)
  assert.equal(ask.title, 'rm -rf build')
  assert.deepEqual(get(ask, 'options'), [
    { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
    { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
  ])
  send(b.inbox, { answer: ask.id, optionId: 'allow_once' })
  assert.equal(await run.exited, 0, run.stderr)
  assert.equal(answer(run.events), 'chose allow_once')
})

test('with RELAY_POLICY=ask and no inbox no answer can come back, so the request is denied', async () => {
  assert.equal(answer((await fake({ FAKE_ASK: '1', RELAY_POLICY: 'ask' })).events), 'chose reject_once')
})
