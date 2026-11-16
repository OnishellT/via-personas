// A local stand-in for a model provider, so the real harnesses run behind the real relay at no cost. Codex
// calls the Responses API (POST /v1/responses); OpenCode an OpenAI-compatible one (POST /v1/chat/completions).
// Each model request takes the next queued reply; a tool-call turn takes two: the call, then the answer after
// the harness sends the tool's output. The Responses builders are codex-acp's own
// (src/__tests__/integration/mock-responses-server.ts), so a reply here is one Codex is known to take.
import http from 'node:http'

// A reply is an SSE body, or a function of the request body and response that returns one, or null once it
// has dealt with the response itself (see `hang`).
export async function startFakeModel() {
  const queue = []
  const requests = []
  const unexpected = []
  // Requests a harness makes on the side, such as OpenCode's session title: answered, and kept out of `requests`.
  const asides = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', async () => {
      let parsed = {}
      try {
        parsed = body ? JSON.parse(body) : {}
      } catch {
        parsed = body
      }
      const path = (req.url ?? '').split('?')[0]
      const model = req.method === 'POST' && (path.endsWith('/responses') || path.endsWith('/chat/completions'))
      if (!model) {
        // A model listing or anything else: not scripted, and not a model call.
        unexpected.push(`${req.method} ${path}`)
        res.writeHead(404)
        return res.end()
      }
      const aside = asides.find(([match]) => match(parsed))
      if (aside) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        return res.end(aside[1])
      }
      requests.push(parsed)
      let next = queue.shift()
      if (typeof next === 'function') next = await next(parsed, res)
      if (next === null || res.destroyed) return
      if (next === undefined) {
        unexpected.push(`${req.method} ${path} #${requests.length}`)
        res.writeHead(400)
        return res.end(`fake model: no reply scripted for request #${requests.length}`)
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(next)
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    unexpected,
    enqueue: (...replies) => queue.push(...replies),
    /** Answers every request `match` picks with `reply`, outside the queue. */
    aside: (match, reply) => asides.push([match, reply]),
    /** Resolves once the harness has made `n` model requests. */
    requested: async (n, timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs
      while (requests.length < n) {
        if (Date.now() > deadline) throw new Error(`the harness made ${requests.length} model requests, not ${n}`)
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    },
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** A reply that never comes: the request stays open until the harness drops it, as a cancelled turn does. */
export const hang = () => (_body, res) => new Promise((resolve) => res.on('close', () => resolve(null)))

// ---- Responses API (Codex) ----

const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
let counter = 0
const nextId = () => `resp_${++counter}`
const wrap = (id, events) =>
  sse([
    { type: 'response.created', response: { id } },
    ...events,
    {
      type: 'response.completed',
      response: {
        id,
        usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 },
      },
    },
  ])

/** The model answers with text, streamed as one delta per chunk. */
export function textResponse(...chunks) {
  const itemId = `msg_${nextId()}`
  const text = chunks.join('')
  return wrap(nextId(), [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', id: itemId, content: [] } },
    ...chunks.map((delta) => ({ type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta })),
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'message', role: 'assistant', id: itemId, content: [{ type: 'output_text', text }] },
    },
  ])
}

/** The model calls Codex's shell tool `exec_command` with `args`, such as `{ cmd: 'echo hi' }`. */
export function execCommandResponse(callId, args) {
  return wrap(nextId(), [
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'function_call', id: `fc_${callId}`, call_id: callId, name: 'exec_command', arguments: JSON.stringify(args) },
    },
  ])
}

// ---- Chat Completions (OpenCode) ----

const chunk = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 0, model: 'fake', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
const usage = `data: ${JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 0, model: 'fake', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`

/** The model answers with text, streamed as one delta per chunk. */
export function chatText(...chunks) {
  return [
    chunk({ role: 'assistant', content: '' }),
    ...chunks.map((content) => chunk({ content })),
    chunk({}, 'stop'),
    usage,
    'data: [DONE]\n\n',
  ].join('')
}

/** The model calls the tool `name` (OpenCode 2.2.7's shell tool is `shell`) with `args`. */
export function chatToolCall(callId, name, args) {
  return [
    chunk({
      role: 'assistant',
      content: null,
      tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: '' } }],
    }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }),
    chunk({}, 'tool_calls'),
    usage,
    'data: [DONE]\n\n',
  ].join('')
}
