// A fake ACP agent for the relay's tests, on the SDK's own agent side. By default its prompt fails as
// codex-acp's does when Codex hits its usage limit, with the cause in the error's data. With FAKE_ECHO
// set it takes images and answers with what it was offered: the client's capabilities, as the SDK
// hands them to an agent, and the prompt's block types; FAKE_STOP is the stop reason it ends with.
// FAKE_CLOSE advertises session/close; FAKE_HANG holds the prompt until a cancel, or with `stubborn` past
// it; FAKE_LOG names a file each cancel and close is written to.
import { appendFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
// The unstable schema, as codex-acp's: the stable one has no plan capability and drops it.
import * as acp from '@agentclientprotocol/sdk/unstable'

const echo = process.env.FAKE_ECHO === '1'
const log = (what) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, `${what}\n`)
let offered
let release
await acp
  .agent()
  .onRequest(acp.methods.agent.initialize, (ctx) => {
    offered = ctx.params.clientCapabilities
    const sessionCapabilities = process.env.FAKE_CLOSE === '1' ? { close: {} } : {}
    return { protocolVersion: ctx.params.protocolVersion, agentCapabilities: { promptCapabilities: { image: echo }, sessionCapabilities } }
  })
  .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 's1' }))
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
