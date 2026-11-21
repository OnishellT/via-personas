import type { EngineInterface } from 'claude-code'
import type { Adapter, GuideAdapter } from './adapter'
import { onPath } from './installed'
import { cachedModels } from './models'
import { isForeign, loadPersonas, refusal } from './personas'

// The crew guide: what the host needs to use every foreign subagent from its first turn, with no lookup.
// It rides in the context of every session, so it is short: about 600 tokens with all six harnesses.
// Measured on a real session: 1500 characters were 640 tokens, 2.3 characters a token, because ids and punctuation
// are dense. Do not grow the text without measuring it again (compare the input tokens of two sessions).
const SHOWN = 2 // models named per harness; the harness's own command lists the rest
const SPACE = 64 // characters of model ids per harness: pi and opencode ids are long, and the guide stays short

export type GuideHarness = {
  adapter: GuideAdapter
  models: readonly string[] // the harness's cached list, best first
  configured?: string // the model the harness's own settings name: what a run with no model line uses
}
export type GuidePersona = { name: string; harness: string }

function harnessLine({ adapter, models: cached, configured }: GuideHarness): string {
  const name = adapter.name
  const lines: string[] = []
  if (adapter.modelFixed) lines.push(`runs on ${configured ?? 'its own default model'} (no model line)`)
  else {
    const shown: string[] = []
    // The default is said once, so it leaves the list.
    const models = cached.filter((id) => id !== configured)
    for (const id of models.slice(0, SHOWN)) {
      if (shown.length > 0 && [...shown, id].join(', ').length > SPACE) break
      shown.push(id)
    }
    const more = models.length - shown.length
    const rest = adapter.listing ?? `send it \`crew-help\``
    lines.push(
      shown.length > 0
        ? `${configured ? `default ${configured}; ` : ''}models ${shown.join(', ')}${more > 0 ? ` (+${more}: ${rest})` : ` (all: ${rest})`}`
        : configured
          ? `default ${configured}; others: ${rest}`
          : adapter.known
            ? `model ${adapter.known.join(', ')} (set in the harness; more: ${rest})`
            : `models not cached yet (list: ${rest})`,
    )
  }
  if (adapter.note) lines.push(adapter.note)
  if (adapter.thinking === 'offered') lines.push('thinking: any')
  else if (adapter.thinking.length > 0) lines.push(`thinking: ${adapter.thinking.join('|')}`)
  else lines.push('no thinking line')
  if (adapter.readOnly === 'none') lines.push('no tools line')
  if (adapter.options) lines.push('takes config:')
  if (!adapter.steer) lines.push('no interrupt:')
  return `- ${name}: ${lines.join('; ')}`
}

// '' when no harness is installed: there is nothing to say.
export function guideOf(harnesses: readonly GuideHarness[], personas: readonly GuidePersona[]): string {
  if (harnesses.length === 0) return ''
  const out = [
    'Crew guide: other harnesses run as subagents: Agent tool, subagent_type "crew:<harness>" or "crew:<persona>". Skip shell lookups, README reads and help spawns.',
    'Prompt top lines: `model: <id>`, `thinking: <level>` (send it when the user names a level, even if the id ends in one), `tools: read`, `config: <opt>=<value>`. A line a harness lacks is refused; no model line = its default.',
    '`crew-help`: a prompt (not a shell command) to an agent type, for its full options.',
    ...harnesses.map(harnessLine),
    'SendMessage follows up; `interrupt:` first stops the step.',
  ]
  // Names and harnesses only: the agent types' own descriptions, in the Agent tool's list, say what each is for.
  if (personas.length > 0) out.push(`Personas: ${personas.map((p) => `crew:${p.name} (${p.harness})`).join(', ')}`)
  return out.join('\n')
}

type Gatherer = Pick<EngineInterface, 'env' | 'fs' | 'store' | 'ui'>

// The guide for a session in `cwd`, from what is already at hand: the cached model lists, the harnesses on
// PATH, the persona files and, for a fixed harness, its settings. Never throws: a guide is a help, not a need.
export async function crewGuide(
  $: Gatherer,
  world: { adapters: ReadonlyMap<string, Adapter>; defaultModel: string },
  cwd: string,
): Promise<string> {
  const home = ((await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))) ?? ''
  const here = await Promise.all(
    [...world.adapters.values()].map(async (adapter) => ((await onPath($, adapter.bin).catch(() => false)) ? adapter : undefined)),
  )
  const installed = here.filter((a): a is Adapter => a !== undefined)
  const harnesses = await Promise.all(
    installed.map(async (adapter): Promise<GuideHarness> => {
      const { configured } = adapter
      const text = configured && home ? await $.fs.read(`${home}/${configured.file}`).catch(() => undefined) : undefined
      const model = configured && typeof text === 'string' ? configured.pick(text) : undefined
      return {
        adapter,
        models: await cachedModels($, adapter, world.defaultModel).catch(() => []),
        ...(model ? { configured: model } : {}),
      }
    }),
  )
  const names = new Set(installed.map((a) => a.name))
  const kept = new Map<string, GuidePersona>()
  const found = await loadPersonas($, cwd, true).catch(() => [])
  for (const persona of found)
    if (!isForeign(persona) && refusal(persona, { adapters: world.adapters, personas: kept }, names) === undefined)
      kept.set(persona.name, { name: persona.name, harness: persona.harness })
  return guideOf(harnesses, [...kept.values()])
}
