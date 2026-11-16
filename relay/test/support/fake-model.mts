// A local stand-in for a model provider, so the real harnesses run behind the real relay at no cost. Codex
// calls the Responses API (POST /v1/responses); OpenCode an OpenAI-compatible one (POST /v1/chat/completions).
// Each model request takes the next queued reply; a tool-call turn takes two: the call, then the answer after
// the harness sends the tool's output. The Responses builders are codex-acp's own
// (src/__tests__/integration/mock-responses-server.ts), so a reply here is one Codex is known to take.
import { EventEmitter } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

/** One item of a Responses API request's `input`, by the fields the tests read. */
export type InputItem = { readonly type: string; readonly role?: string; readonly content?: unknown; readonly call_id?: string }
/** One Chat Completions message, by the fields the tests read. */
export type ChatMessage = { readonly role: string; readonly content?: unknown; readonly tool_call_id?: string }
/** A model request as the harness sent it. Codex sends `input`, OpenCode `messages`. */
export type ModelRequest = { readonly input?: readonly InputItem[]; readonly messages?: readonly ChatMessage[] }

/** A scripted reply: an SSE body, a function of the request that returns one, or null once it has dealt with the response. */
export type Reply = string | ((body: ModelRequest, res: http.ServerResponse) => string | null | Promise<string | null>)

export type FakeModel = Awaited<ReturnType<typeof startFakeModel>>

export async function startFakeModel() {
  const queue: Reply[] = []
  const requests: ModelRequest[] = []
  // Each request the harness makes is announced, so a test waits on the request itself, never on time.
  const arrived = new EventEmitter()
  const unexpected: string[] = []
  // Requests a harness makes on the side, such as OpenCode's session title: answered, and kept out of `requests`.
  const asides: [match: (body: ModelRequest) => boolean, reply: string][] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk
    })
    req.on('end', async () => {
      let parsed: ModelRequest = {}
      try {
        const value: unknown = body ? JSON.parse(body) : {}
        if (typeof value === 'object' && value !== null) parsed = value as ModelRequest
      } catch {
        // Not JSON: no model request reads as one.
      }
      const path = (req.url ?? '').split('?')[0] ?? ''
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
      arrived.emit('request')
      const scripted = queue.shift()
      const next = typeof scripted === 'function' ? await scripted(parsed, res) : scripted
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
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo

  /**
   * Resolves once the requests made so far satisfy `done`, checked as each one arrives. Rejects when `ended`
   * settles first, such as the run's exit: a wait that can't be met fails then, not after a timeout.
   */
  const until = (done: (made: readonly ModelRequest[]) => boolean, ended?: Promise<unknown>) =>
    new Promise<readonly ModelRequest[]>((resolve, reject) => {
      const check = () => {
        if (!done(requests)) return
        arrived.off('request', check)
        resolve(requests)
      }
      arrived.on('request', check)
      void ended?.then(() => {
        arrived.off('request', check)
        reject(new Error(`the run ended after ${requests.length} model requests, before the one the test waited for`))
      })
      check()
    })

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    unexpected,
    enqueue: (...replies: Reply[]) => {
      queue.push(...replies)
    },
    /** Answers every request `match` picks with `reply`, outside the queue. */
    aside: (match: (body: ModelRequest) => boolean, reply: string) => {
      asides.push([match, reply])
    },
    until,
    /** Resolves once the harness has made `n` model requests; rejects when `ended` settles first. */
    requested: (n: number, ended?: Promise<unknown>) => until((made) => made.length >= n, ended),
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** A reply that never comes: the request stays open until the harness drops it, as a cancelled turn does. */
export const hang = (): Reply => (_body, res) => new Promise((resolve) => res.on('close', () => resolve(null)))

// ---- Responses API (Codex) ----

type ResponsesEvent = { readonly type: string; readonly [field: string]: unknown }
const sse = (events: readonly ResponsesEvent[]) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
let counter = 0
const nextId = () => `resp_${++counter}`
const wrap = (id: string, events: readonly ResponsesEvent[]) =>
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
export function textResponse(...chunks: string[]): string {
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

/** The model calls the tool `name` with `args`; `namespace` names the group a tool sits in, such as Codex's `collaboration`. */
export function functionCallResponse(callId: string, name: string, args: unknown, namespace?: string): string {
  return wrap(nextId(), [
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'function_call',
        id: `fc_${callId}`,
        call_id: callId,
        name,
        ...(namespace ? { namespace } : {}),
        arguments: JSON.stringify(args),
      },
    },
  ])
}

/** The model calls Codex's shell tool `exec_command` with `args`, such as `{ cmd: 'echo hi' }`. */
export const execCommandResponse = (callId: string, args: { readonly cmd: string }) => functionCallResponse(callId, 'exec_command', args)

// ---- Chat Completions (OpenCode) ----

const chunk = (delta: unknown, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 0, model: 'fake', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
const usage = `data: ${JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 0, model: 'fake', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`

/** The model answers with text, streamed as one delta per chunk. */
export function chatText(...chunks: string[]): string {
  return [
    chunk({ role: 'assistant', content: '' }),
    ...chunks.map((content) => chunk({ content })),
    chunk({}, 'stop'),
    usage,
    'data: [DONE]\n\n',
  ].join('')
}

/** The model calls the tool `name` (OpenCode 2.2.7's shell tool is `shell`) with `args`. */
export function chatToolCall(callId: string, name: string, args: unknown): string {
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
