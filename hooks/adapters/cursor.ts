import { relayEvents, sessionLost } from '../acp/events'
import { type AcpSpec, acpStart } from '../acp/spec'
import type { Adapter } from '../adapter'
import { withPersonaBlock } from '../deliver'

// `cursor-agent acp`, tested live on 2026.11.19. Cursor has no read-only mode via can prove (its ask and plan
// modes are its own, and a project's .cursor MCP servers and hooks run outside them), so readOnly is 'none':
// a tools line, plan mode and a read-only run are refused, as for agy. Effort is part of a model's id here, so
// there is no thinking level, and the session offers only mode and model (no tuning options).
export const CURSOR: AcpSpec = {
  name: 'cursor',
  command: ['cursor-agent', 'acp'],
  steer: 'prompt',
  // The person's own permissions: a request reaches the person, except in bypass (approved) and dontAsk (denied).
  // readOnly is never reached (see above); cursor's own `ask` mode is the closest it has.
  modes: {
    readOnly: { agentMode: 'ask', policy: 'deny' },
    bypassPermissions: { policy: 'allow' },
    dontAsk: { policy: 'deny' },
    default: { policy: 'ask' },
  },
}

export const cursor = {
  name: 'cursor',
  bin: 'cursor-agent',
  about: "Cursor CLI agent: the models of the person's Cursor plan, own tools (edits files, runs commands); no read-only mode.",
  // A command that lists models lists them by the CLI's own ids (gpt-5.3-codex-high), which the ACP session
  // refuses: it takes only the values its `model` config option offers, and only a session lists those.
  // Opening one per start would leave a session behind each time, so no list is kept.
  catalogue: { argv: ['cursor-agent', '--version'], ids: () => [] },
  readOnly: 'none',
  thinking: [],
  steer: true,
  defaultModel: false,
  models:
    "Cursor takes only the model values its ACP session offers, brackets included, such as `default[]` (the model chosen in your Cursor settings) or `composer-2.5[fast=true]`; one it refuses ends the run and names it. A plan's own limits apply: a run of a model your plan lacks answers 'Upgrade your plan to continue'.",
  known: ['default[]'],
  listing: 'send it `crew-help`',
  persona: true,
  start: ({ choice, prompt, session, root, inbox, files, mode, persona }) =>
    acpStart(CURSOR, {
      root,
      prompt: withPersonaBlock(prompt, persona),
      readOnly: false,
      mode,
      inbox,
      files,
      session,
      model: choice.model,
    }),
  events: () => relayEvents('cursor'),
  // The relay names the model the session runs on.
  model: () => undefined,
  failure: (_exit, stderr) =>
    sessionLost(stderr)
      ? {
          message:
            "cursor could not find this agent's earlier session, so this message did not run. Send it again to start a new cursor session.",
          sessionLost: true,
        }
      : undefined,
} as const satisfies Adapter
