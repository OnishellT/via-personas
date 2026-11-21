import { cap, clip, tail } from '../acp/events'
import { isRecord } from '../acp/json'
import type { Adapter, Norm } from '../adapter'
import { withPersonaBlock } from '../deliver'

// Written from zcode 0.17.1's `-p --output-format stream-json`, captured 2026-11-21: one JSON object per
// line, each an event `{ type, sessionId, payload }`, and a last `{ type: "result", sessionId, response, usage }`
// that is the same object `--json` prints in one piece. zcode publishes no types for it, so tests pin these
// shapes. Plain `--json` has no events, so its run would show no step rows.
const text = (value: unknown) => (typeof value === 'string' ? value : '')

function parse(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line)
    return isRecord(parsed) && typeof parsed.type === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

// zcode's tools as ACP kinds, so their rows draw and fold as Codex's do; any other (an MCP server's) is `other`.
const KINDS: Record<string, string> = {
  Bash: 'execute',
  Read: 'read',
  Write: 'edit',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Grep: 'search',
  Glob: 'search',
}

const pathOf = (input: Record<string, unknown>) => text(input.file_path) || text(input.path) || text(input.notebook_path)

function titleOf(tool: string, input: Record<string, unknown>): string {
  const path = pathOf(input)
  switch (tool) {
    case 'Bash':
      return text(input.command) || text(input.description) || 'Bash'
    case 'Read':
      return `Read ${path}`
    case 'Write':
      return `Write ${path}`
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Edit ${path}`
    case 'Grep':
    case 'Glob':
      return [tool.toLowerCase(), text(input.pattern), text(input.path)].filter(Boolean).join(' ')
    default:
      return `${tool}: ${JSON.stringify(input)}`
  }
}

// A command that exits nonzero still "succeeds" as a tool call; zcode says its exit code beside the result.
function exitCode(result: Record<string, unknown>): number | undefined {
  const perf = isRecord(result.perf) ? result.perf : {}
  const detail = isRecord(perf.detail) ? perf.detail : {}
  const command = isRecord(detail.command) ? detail.command : {}
  return typeof command.exitCode === 'number' ? command.exitCode : undefined
}

export const zcode = {
  name: 'zcode',
  bin: 'zcode',
  about: "ZCode CLI agent: runs on ZCode's own default model (no model line), own tools (edits files; no read-only mode).",
  // zcode lists no models: its global default is the only one, so there is no catalogue to read.
  readOnly: 'none',
  thinking: [],
  steer: false,
  defaultModel: false,
  modelFixed: true,
  persona: true,
  // The prompt is one `--prompt=` argument: `-p` with a prompt that starts with a dash is ambiguous to zcode,
  // and it reads no stdin. Only the global default model runs (no model flag); it runs with its own
  // permissions (yolo for a prompt), outside Claude Code's.
  start: ({ prompt, session, persona }) => ({
    argv: [
      'zcode',
      `--prompt=${withPersonaBlock(prompt, persona)}`,
      '--output-format',
      'stream-json',
      ...(session ? ['--resume', session] : []),
    ],
  }),
  events: () => {
    let sessionId = ''
    let model = ''
    // The answer was streamed: the closing `result` repeats it, so it only fills in for a run that streamed none.
    let streamed = false
    // A call's input, for its row when it ends.
    const calls = new Map<string, { tool: string; input: Record<string, unknown> }>()
    return (line): Norm[] => {
      const e = parse(line)
      if (!e) return []
      const out: Norm[] = []
      if (!sessionId && typeof e.sessionId === 'string' && e.sessionId) {
        sessionId = e.sessionId
        out.push({ k: 'session', id: sessionId })
      }
      const p = isRecord(e.payload) ? e.payload : {}
      switch (e.type) {
        case 'result':
          if (!streamed && text(e.response).trim()) out.push({ k: 'message' }, { k: 'text', t: text(e.response) })
          return out
        case 'model.streaming': {
          const delta = text(p.delta)
          switch (p.kind) {
            case 'start':
              streamed = false
              out.push({ k: 'message' })
              break
            case 'text_delta':
              if (delta) {
                streamed = true
                out.push({ k: 'text', t: delta })
              }
              break
            case 'reasoning_delta':
              if (delta) out.push({ k: 'thinking', t: delta })
              break
            case 'tool_call': {
              const tool = text(p.toolName) || 'tool'
              const input = isRecord(p.input) ? p.input : {}
              const path = pathOf(input)
              // A call with no id cannot be matched to its end: it stays a text line.
              if (typeof p.toolCallId !== 'string' || !p.toolCallId)
                return [...out, { k: 'tool', t: `\n▸ ${clip(`${tool}: ${JSON.stringify(input)}`)}\n` }]
              calls.set(p.toolCallId, { tool, input })
              out.push({
                k: 'call',
                id: p.toolCallId,
                kind: KINDS[tool] ?? 'other',
                title: clip(titleOf(tool, input)),
                ...(path.startsWith('/') ? { path } : {}),
              })
              break
            }
          }
          return out
        }
        case 'tool.updated': {
          const id = text(p.toolCallId)
          const call = calls.get(id)
          if (!call || (p.kind !== 'result' && p.kind !== 'error')) return out
          calls.delete(id)
          if (p.kind === 'error') {
            const why = isRecord(p.error) ? text(p.error.message) : ''
            return [...out, { k: 'called', id, output: why || 'zcode reported an error', failed: true }]
          }
          const result = isRecord(p.result) ? p.result : {}
          const said = text(result.content).trim()
          const code = exitCode(result)
          const failed = result.success === false || (code !== undefined && code !== 0)
          return [...out, { k: 'called', id, output: call.tool === 'Bash' ? tail(said, 2000) : cap(said, 2000), failed }]
        }
        case 'session.updated': {
          // The model of each call, named once: `providerId` is an account's route, not part of the model's name.
          const id = text(p.modelId)
          if (id && id !== model) {
            model = id
            out.push({ k: 'model', name: id })
          }
          // A model call's end carries its own usage; inputTokens counts the cached reads.
          if (isRecord(p.usage) && typeof p.stopReason === 'string') {
            const u = p.usage
            const num = (key: string) => (typeof u[key] === 'number' ? u[key] : 0)
            const cacheRead = num('cacheReadTokens')
            out.push({
              k: 'usage',
              usage: {
                input: Math.max(0, num('inputTokens') - cacheRead),
                cacheRead,
                cacheWrite: num('cacheWriteTokens'),
                output: num('outputTokens'),
              },
            })
          }
          return out
        }
        case 'turn.failed': {
          const why = isRecord(p.error) ? text(p.error.message) : text(p.message) || text(p.reason)
          return [...out, { k: 'error', message: why || 'the turn failed' }]
        }
        default:
          return out
      }
    }
  },
  // zcode names its model in the stream; with none named, the answer says so.
  model: () => undefined,
  failure: (_exit, stderr) =>
    /Session not found/i.test(stderr)
      ? {
          message:
            "zcode could not find this agent's earlier session, so this message did not run. Send it again to start a new zcode session.",
          sessionLost: true,
        }
      : undefined,
} as const satisfies Adapter
