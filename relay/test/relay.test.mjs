import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const relay = new URL('../relay.mjs', import.meta.url).pathname
const agent = new URL('./fake-agent.mjs', import.meta.url).pathname

test("an agent's error keeps the cause its data carries, not only 'Internal error'", () => {
  const run = spawnSync('node', [relay, '--', 'node', agent], { input: 'hi', encoding: 'utf8', timeout: 20_000 })
  const events = run.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const error = events.find((e) => e.relay === 'error')
  assert.equal(error?.message, "Internal error: You've hit your usage limit. Try again at 10:04 PM.")
  assert.equal(run.status, 1)
})

test('a refused or limit-stopped prompt is forwarded as it ended, not as a relay failure', () => {
  for (const stop of ['refusal', 'max_tokens', 'max_turn_requests']) {
    const run = spawnSync('node', [relay, '--', 'node', agent], {
      input: 'hi',
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, FAKE_ECHO: '1', FAKE_STOP: stop },
    })
    const events = run.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    assert.equal(events.find((e) => e.relay === 'prompt_done')?.stopReason, stop)
    assert.equal(events.find((e) => e.relay === 'done')?.stopReason, stop)
    assert.equal(
      events.some((e) => e.relay === 'error'),
      false,
    )
    assert.equal(run.status, 0)
  }
})

const said = (input, cwd = process.cwd()) => {
  const run = spawnSync('node', [relay, '--', 'node', agent], {
    input,
    cwd,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, FAKE_ECHO: '1' },
  })
  const text = run.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((e) => e.update?.sessionUpdate === 'agent_message_chunk')?.update.content.text
  return JSON.parse(text)
}

test('the relay offers streamed command output, no terminal of its own, and no plan capability', () => {
  const { offered } = said('hi')
  // With one, codex-acp sends a markdown plan as plan_update, which via does not draw, in place of text.
  assert.equal(offered.plan, undefined)
  assert.equal(offered._meta.terminal_output_delta, true)
  assert.equal(offered.terminal, false)
  assert.deepEqual(offered.session.notices, {})
})

test('an image under the working folder goes along to an agent that takes images; a missing, fake or outside one stays text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-test-'))
  const outside = mkdtempSync(join(tmpdir(), 'relay-outside-'))
  const png = join(dir, 'shot.png')
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  writeFileSync(join(dir, 'fake.png'), 'not a png')
  writeFileSync(join(outside, 'secret.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const prompt = `Look at ${png}, ${join(dir, 'gone.png')}, ${join(dir, 'fake.png')}, ${join(outside, 'secret.png')} and docs${png}`
  assert.deepEqual(said(prompt, dir).blocks, ['text', 'image:image/png:8'])
})

test('a symlink or .. that leads out of the working folder stays text, and at most four images go along', () => {
  // Real paths (macOS's temp folder is itself a symlink), so only the link or the .. decides.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-test-')))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'relay-outside-')))
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  writeFileSync(join(outside, 'secret.png'), png)
  symlinkSync(join(outside, 'secret.png'), join(dir, 'link.png'))
  mkdirSync(join(dir, 'sub'))
  // Written out, not joined: join would resolve the .. before the relay sees it.
  const outOfRoots = `${dir}/sub/../../${outside.split('/').pop()}/secret.png`
  assert.deepEqual(said(`See ${join(dir, 'link.png')} and ${outOfRoots}`, dir).blocks, ['text'])
  const many = [1, 2, 3, 4, 5].map((n) => {
    const path = join(dir, `${n}.png`)
    writeFileSync(path, png)
    return path
  })
  assert.equal(said(`See ${many.join(' ')}`, dir).blocks.length, 1 + 4)
})

const logged = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [])

test('a run that ends closes its session when the agent can close one, and only then', () => {
  for (const close of ['1', '']) {
    const log = join(mkdtempSync(join(tmpdir(), 'relay-')), 'log')
    const run = spawnSync('node', [relay, '--', 'node', agent], {
      input: 'hi',
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, FAKE_ECHO: '1', FAKE_CLOSE: close, FAKE_LOG: log },
    })
    assert.equal(run.status, 0)
    assert.deepEqual(logged(log), close ? ['close'] : [])
  }
})

// The agent keeps its turn past the cancel, so the run never reaches its own end: the close is the stop's.
test('a stopped run cancels the turn, then closes the session, before the kill', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'relay-')), 'log')
  const run = spawn('node', [relay, '--', 'node', agent], {
    env: { ...process.env, FAKE_CLOSE: '1', FAKE_HANG: 'stubborn', FAKE_LOG: log },
  })
  let stdout = ''
  run.stdout.on('data', (data) => (stdout += data))
  run.stdin.end('hi')
  const deadline = Date.now() + 10_000
  while (!logged(log).includes('prompt') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
  run.kill('SIGTERM')
  await new Promise((resolve) => run.on('exit', resolve))
  assert.deepEqual(logged(log), ['prompt', 'cancel', 'close'])
  assert.equal(stdout.includes('"relay":"done"'), false)
})
