import type { EngineInterface } from 'claude-code'
import type { Adapter, GuideAdapter } from './adapter'
import { onPath } from './installed'
import { cachedModels } from './models'
import { isForeign, loadPersonas, refusal } from './personas'

// The crew guide: what the host needs to use every foreign subagent from its first turn, with no lookup.
// It rides in the context of every session, so it is short: about 600 tokens with all six harnesses.
const SHOWN = 8 // models named per harness; the harness's own command lists the rest
const SPACE = 130 // characters of model ids per harness: pi and opencode ids are long, and the guide stays short
const BLURB = 60 // characters of a persona's description

export type GuideHarness = {
  adapter: GuideAdapter
  models: readonly string[] // the harness's cached list, best first
  fallback?: string // the harness's configured default, when its cached list leads with it (pi)
  configured?: string // the model a fixed harness runs, read from its own settings
}
export type GuidePersona = { name: string; harness: string; description: string }

const clip = (text: string, max: number) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

function harnessLine({ adapter, models, configured, fallback }: GuideHarness): string {
  const name = adapter.name
  const lines: string[] = []
  if (adapter.modelFixed) lines.push(`runs on ${configured ?? 'its own default model'} (no model line)`)
  else {
    const shown: string[] = []
    for (const id of models.slice(0, SHOWN)) {
      if (shown.length > 0 && [...shown, id].join(', ').length > SPACE) break
      shown.push(id)
    }
    const more = models.length - shown.length
    const rest = adapter.listing ?? `send it \`crew-help\``
    lines.push(
      shown.length > 0
        ? `${fallback ? `default ${fallback}; ` : ''}models ${shown.join(', ')}${more > 0 ? ` (+${more} more: ${rest})` : ` (all: ${rest})`}`
        : adapter.known
          ? `model ${adapter.known.join(', ')} is the one set in the harness; others: ${rest}`
          : `models not cached yet (list: ${rest})`,
    )
  }
  if (adapter.thinking === 'offered') lines.push('thinking: any the model offers')
  else if (adapter.thinking.length > 0) lines.push(`thinking: ${adapter.thinking.join('|')}`)
  else lines.push('no thinking line')
  if (adapter.readOnly === 'none') lines.push('no tools line (no read-only)')
  if (adapter.options) lines.push('takes config:')
  if (!adapter.steer) lines.push('no interrupt:')
  return `- ${name}: ${lines.join('; ')}`
}

// '' when no harness is installed: there is nothing to say.
export function guideOf(harnesses: readonly GuideHarness[], personas: readonly GuidePersona[]): string {
  if (harnesses.length === 0) return ''
  const out = [
    'Crew guide: other coding-agent harnesses run as subagents. Agent tool, subagent_type "crew:<harness>" (generic, follows your prompt) or "crew:<persona>". All you need is here: no shell lookups, README reading or help spawns first.',
    'Prompt top lines, one per line, kept for follow-ups: `model: <id>`, `thinking: <level>`, `tools: read` (read-only), `config: <option>=<value>`. A line a harness lacks is refused; with no model line it runs its own default.',
    '`crew-help` is a prompt (not a shell command) sent to an agent type for its full options.',
    ...harnesses.map(harnessLine),
    'SendMessage follows up; a message starting `interrupt:` stops the current step.',
  ]
  if (personas.length > 0) out.push('Personas:', ...personas.map((p) => `- crew:${p.name} (${p.harness}): ${clip(p.description, BLURB)}`))
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
      const cached = await cachedModels($, adapter, world.defaultModel).catch(() => [])
      // pi's list leads with the model its settings choose, so its first is the one a run with no model line uses.
      const fallback = adapter.name === 'pi' && cached.length > 0 ? cached[0] : undefined
      return {
        adapter,
        models: cached,
        ...(model ? { configured: model } : {}),
        ...(fallback ? { fallback } : {}),
      }
    }),
  )
  const names = new Set(installed.map((a) => a.name))
  const kept = new Map<string, GuidePersona>()
  const found = await loadPersonas($, cwd, true).catch(() => [])
  for (const persona of found)
    if (!isForeign(persona) && refusal(persona, { adapters: world.adapters, personas: kept }, names) === undefined)
      kept.set(persona.name, { name: persona.name, harness: persona.harness, description: persona.description })
  return guideOf(harnesses, [...kept.values()])
}
