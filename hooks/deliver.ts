import type { Delivery } from './adapter'

// A harness with no system-prompt channel gets its persona as a block at the start of a prompt that opens its
// session: the persona's `fresh`, which the run layer settles from what the session has already taken (see
// AgentRecord.delivered). A follow-up does not repeat the block; a new session, or one whose first prompt failed
// before the harness answered, gets it again.
export function withPersonaBlock(prompt: string, persona: Delivery | undefined): string {
  if (!persona || persona.fresh === false) return prompt
  return `<persona name="${persona.name}">\n${persona.body}\n</persona>\n\n${prompt}`
}
