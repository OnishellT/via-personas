// Runs the real relay (relay/relay.mjs) over a real harness, as via does, and reads what it printed.
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const relay = new URL('../../relay.mjs', import.meta.url).pathname

/** Whether `bin` runs from PATH: a test of a harness that isn't installed is skipped, not failed. */
export const installed = (bin) => spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 20_000 }).status === 0

/**
 * A fresh home for one test: an empty HOME (so no login, config or auth of the person's is read), a working
 * folder, and an inbox file. Real paths: macOS's temp folder is a symlink, and the harness reports real ones.
 */
export function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-real-')))
  process.on('exit', () => rmSync(root, { recursive: true, force: true }))
  const dirs = { root, home: join(root, 'home'), work: join(root, 'work'), inbox: join(root, 'inbox.jsonl') }
  mkdirSync(dirs.home)
  mkdirSync(dirs.work)
  writeFileSync(dirs.inbox, '')
  return dirs
}

/**
 * Starts the relay over `agent` with `prompt` on stdin. Only PATH comes from this process's environment: no
 * provider key or config of the person's reaches the harness. `events` grows as the relay prints.
 */
export function startRelay({ agent, prompt, env, cwd, timeoutMs = 30_000 }) {
  const run = spawn('node', [relay, '--', ...agent], { cwd, env: { PATH: process.env.PATH, ...env } })
  const events = []
  let partial = ''
  let stderr = ''
  run.stdout.on('data', (data) => {
    partial += data
    const lines = partial.split('\n')
    partial = lines.pop()
    for (const line of lines) if (line.trim()) events.push(JSON.parse(line))
  })
  run.stderr.on('data', (data) => (stderr += data))
  run.stdin.end(prompt)
  // A run the harness never ends is stopped as the engine stops one, so a hang fails the test, not the suite.
  const timer = setTimeout(() => {
    stderr += `\nstopped after ${timeoutMs} ms`
    run.kill('SIGTERM')
  }, timeoutMs)
  // close, not exit: every line printed has been read.
  const exited = new Promise((resolve) =>
    run.on('close', (code) => {
      clearTimeout(timer)
      resolve(code)
    }),
  )
  return {
    events,
    get stderr() {
      return stderr
    },
    exited,
    /** Stops the run as the engine does. */
    stop: () => run.kill('SIGTERM'),
  }
}

/** Runs the relay to its end. */
export async function runRelay(options) {
  const run = startRelay(options)
  const status = await run.exited
  return { status, events: run.events, stderr: run.stderr }
}

/** Whether a process whose whole command line is `command` runs, waiting up to `timeoutMs` for one to start. */
export async function running(command, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  do {
    if (spawnSync('pgrep', ['-f', `^${command}$`]).status === 0) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  return false
}

/** Appends one line to the relay's inbox, as the plugin does. */
export const send = (inbox, value) => appendFileSync(inbox, `${JSON.stringify(value)}\n`)

// ---- What the relay printed ----

export const updates = (events) => events.flatMap((e) => (e.update ? [e.update] : []))
export const answer = (events) =>
  updates(events)
    .filter((u) => u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text')
    .map((u) => u.content.text)
    .join('')
/** A resumed session's replayed history, before the relay's first prompt, and the answer after it. */
export const spoken = (events) => {
  const first = events.findIndex((e) => e.relay === 'steered')
  return { replayed: answer(events.slice(0, first)), answered: answer(events.slice(first)) }
}
export const relayEvent = (events, name) => events.find((e) => e.relay === name)
export const relayEvents = (events) => events.flatMap((e) => (e.relay ? [e.relay] : []))
export const toolCalls = (events) =>
  updates(events).filter((u) => u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update')
