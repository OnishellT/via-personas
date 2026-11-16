// A fake ACP agent for the relay's tests, on the SDK's own agent side. By default its prompt fails as
// codex-acp's does when Codex hits its usage limit, with the cause in the error's data. With FAKE_ECHO
// set it takes images and answers with what it was offered: the client's capabilities, as the SDK
// hands them to an agent, and the prompt's block types; FAKE_STOP is the stop reason it ends with.
// FAKE_CLOSE advertises session/close; FAKE_HANG holds the prompt until a cancel, or with `stubborn` past
// it; FAKE_LOG names a file each cancel and close is written to. FAKE_OPTIONS offers config options, as
// codex-acp does: a model and its reasoning efforts; each set one is logged.
import { appendFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
// The unstable schema, as codex-acp's: the stable one has no plan capability and drops it.
import * as acp from '@agentclientprotocol/sdk/unstable'

const echo = process.env.FAKE_ECHO === '1'
const log = (what) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, `${what}\n`)
let offered
const select = (id, category, currentValue, values) => ({
  id,
  name: id,
  category,
  type: 'select',
  currentValue,
  options: values.map((value) => ({ value, name: value })),
})
// As codex-acp 2.6.0 offers them for gpt-6-luna: no ultra.
const OPTIONS = [
  select('model', 'model', 'gpt-6-luna', ['gpt-6-luna', 'gpt-6.1-sol']),
  select('reasoning_effort', 'thought_level', 'medium', ['low', 'medium', 'high', 'xhigh']),
  select('mode', 'mode', 'read-only', ['read-only', 'agent-full-access']),
  select('fast-mode', 'model_config', 'off', ['off', 'on']),
]
let release
await acp
  .agent()
  .onRequest(acp.methods.agent.initialize, (ctx) => {
    offered = ctx.params.clientCapabilities
    const sessionCapabilities = process.env.FAKE_CLOSE === '1' ? { close: {} } : {}
    return { protocolVersion: ctx.params.protocolVersion, agentCapabilities: { promptCapabilities: { image: echo }, sessionCapabilities } }
  })
  .onRequest(acp.methods.agent.session.new, () =>
    process.env.FAKE_OPTIONS === '1' ? { sessionId: 's1', configOptions: OPTIONS } : { sessionId: 's1' },
  )
  .onRequest(acp.methods.agent.session.setMode, (ctx) => {
    log(`mode ${ctx.params.modeId}`)
    return {}
  })
  .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => {
    log(`set ${ctx.params.configId}=${ctx.params.value}`)
    return { configOptions: OPTIONS }
  })
  .onRequest(acp.methods.agent.session.close, () => {
    log('close')
    return {}
  })
  .onNotification(acp.methods.agent.session.cancel, () => {
    log('cancel')
    if (process.env.FAKE_HANG !== 'stubborn') release?.()
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    if (process.env.FAKE_HANG) {
      log('prompt')
      await new Promise((resolve) => (release = resolve))
      return { stopReason: 'cancelled' }
    }
    if (!echo) throw acp.RequestError.internalError({ details: "You've hit your usage limit. Try again at 10:04 PM." })
    const blocks = ctx.params.prompt.map((b) => (b.type === 'image' ? `image:${b.mimeType}:${b.data.length}` : b.type))
    const text = JSON.stringify({ offered, blocks })
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: 's1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    })
    return { stopReason: process.env.FAKE_STOP || 'end_turn' }
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))).closed
