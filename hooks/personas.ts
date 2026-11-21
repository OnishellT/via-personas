import type { EngineInterface } from 'claude-code'
import type { Adapter, PromptAdapter } from './adapter'
import { promptOf } from './prompt'

// A persona: an agent written once, in <session cwd>/.agents/agents/<name>.md, run by the harness it names.
// model, tools and thinking are defaults: a prompt line of the same key overrides them.
export type Persona = {
  name: string
  description: string
  harness: string
  model?: string
  tools?: string
  thinking?: string
  body: string // the instructions: the persona's system prompt
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const DIR = '.agents/agents'

function unquoted(value: string): string {
  const v = value.trim()
  const q = v[0]
  return v.length >= 2 && (q === '"' || q === "'") && v.at(-1) === q ? v.slice(1, -1) : v
}

// Flat `key: value` frontmatter between two `---` lines, then the instructions. A string says why the file is no persona.
export function parsePersona(file: string, text: string): Persona | string {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return 'no frontmatter'
  const close = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
  if (close < 0) return 'unterminated frontmatter'
  const fields = new Map<string, string>()
  for (const line of lines.slice(1, close)) {
    const at = line.indexOf(':')
    if (at < 1 || /^\s*#/.test(line)) continue
    fields.set(line.slice(0, at).trim().toLowerCase(), unquoted(line.slice(at + 1)))
  }
  const name = fields.get('name') ?? ''
  const description = fields.get('description') ?? ''
  if (!NAME.test(name)) return `bad or missing name ${JSON.stringify(name)}`
  if (name !== file.replace(/\.md$/, '')) return `name ${JSON.stringify(name)} does not match the file name`
  if (!description) return 'missing description'
  const persona: Persona = {
    name,
    description,
    harness: fields.get('harness') ?? '',
    body: lines
      .slice(close + 1)
      .join('\n')
      .trim(),
  }
  const model = fields.get('harness-model')
  const tools = fields.get('tools')?.replace(/\s+/g, '')
  const thinking = fields.get('thinking')
  if (model) persona.model = model
  if (tools) persona.tools = tools
  if (thinking) persona.thinking = thinking
  return persona
}

// A persona's defaults, checked as a prompt line of that key would be by its harness; a refused one is dropped.
// Returns the persona with the valid ones, and what was refused.
export function checked(persona: Persona, adapter: PromptAdapter): { persona: Persona; refused: string[] } {
  const refused: string[] = []
  const out: Persona = { ...persona }
  for (const [key, field] of [
    ['model', 'model'],
    ['tools', 'tools'],
    ['thinking', 'thinking'],
  ] as const) {
    const value = persona[field]
    if (value === undefined) continue
    const spec = promptOf(`${key}: ${value}\n.`, adapter)
    if (spec.error !== undefined || spec[field] !== value) {
      refused.push(`${key} ${JSON.stringify(value)}`)
      delete out[field]
    }
  }
  return { persona: out, refused }
}

type Loader = Pick<EngineInterface, 'fs' | 'ui'>

// Every persona of the folder that is well formed, by name; a bad file is said and skipped, never a crash.
// quiet: the skipped files are not said (the guide reads them again after session.start's own pass said them).
export async function loadPersonas($: Loader, cwd: string, quiet = false): Promise<Persona[]> {
  const dir = `${cwd.replace(/\/+$/, '')}/${DIR}`
  const entries = await $.fs.list(dir).catch(() => undefined)
  if (entries === undefined) return []
  const found: Persona[] = []
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith('.md')) continue
    try {
      const parsed = parsePersona(entry.name, await $.fs.read(`${dir}/${entry.name}`))
      if (typeof parsed === 'string') {
        if (!quiet) $.ui.log(`crew skipped persona ${entry.name}: ${parsed}`)
      } else found.push(parsed)
    } catch (error) {
      if (!quiet) $.ui.log(`crew skipped persona ${entry.name}: ${String(error)}`)
    }
  }
  return found
}

type Known = { adapters: ReadonlyMap<string, Adapter>; personas: ReadonlyMap<string, Persona> }

// What an agent type `<plugin>:<x>` runs: a harness by its own name, or a persona by its. The agent type of
// a persona is only registered when its harness is installed, so a persona whose harness is gone resolves to nothing.
export function resolveType(w: Known, plugin: string | undefined, type: string): { adapter: Adapter; persona?: string } | undefined {
  const [from, name = ''] = type.split(':')
  if (from !== plugin) return undefined
  const adapter = w.adapters.get(name)
  if (adapter) return { adapter }
  const persona = w.personas.get(name)
  const harness = persona ? w.adapters.get(persona.harness) : undefined
  return persona && harness ? { adapter: harness, persona: persona.name } : undefined
}

// A persona written for another host (no harness, or claude's own) is no business of crew's, and not said.
export const isForeign = (found: Persona) => found.harness === '' || found.harness === 'claude'

// Why a persona of the folder gets no agent type, or undefined when it does. installed: the harnesses on PATH;
// taken: the personas already registered, by name.
export function refusal(
  found: Persona,
  w: { adapters: ReadonlyMap<string, Adapter>; personas: ReadonlyMap<string, unknown> },
  installed: ReadonlySet<string>,
): string | undefined {
  const adapter = w.adapters.get(found.harness)
  if (w.adapters.has(found.name)) return `its name is a harness's name`
  if (w.personas.has(found.name)) return 'a persona of that name is already registered'
  if (adapter === undefined) return `harness ${JSON.stringify(found.harness)} is not one crew drives`
  if (!adapter.persona) return `${adapter.name} does not take persona instructions yet`
  if (!installed.has(adapter.name)) return `${adapter.bin} is not on PATH`
  return undefined
}
