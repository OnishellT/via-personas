import { agy } from './adapters/agy'
import { codex } from './adapters/codex'
import { cursor } from './adapters/cursor'
import { opencode } from './adapters/opencode'
import { pi } from './adapters/pi'

// The harnesses this plugin can drive; their names are derived from here, not listed twice.
export const HARNESSES = [pi, codex, agy, opencode, cursor] as const
export type HarnessName = (typeof HARNESSES)[number]['name']
