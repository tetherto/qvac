import type { AgentPromptBlock } from '@qvac/agents'
import type { SkillCatalogEntry } from './catalog.ts'

export const SKILLS_INDEX_BLOCK_ID = 'skills-index'
export const DEFAULT_MAX_SKILL_BODY_CHARS = 8_000

const TRUNCATION_NOTICE = '\n\n[skill instructions truncated]'

export interface ComposeSkillPromptOptions {
  readonly catalog: readonly SkillCatalogEntry[]
  readonly selected: readonly string[]
  readonly maxBodyChars?: number
}

/**
 * Turns a skill catalog into system-prompt blocks with two levels of
 * disclosure: every skill is named so the model can say when it lacks one, and
 * the selected skills carry their full instructions.
 */
export function composeSkillPrompt({
  catalog,
  selected,
  maxBodyChars = DEFAULT_MAX_SKILL_BODY_CHARS
}: ComposeSkillPromptOptions): readonly AgentPromptBlock[] {
  if (catalog.length === 0) return []
  const chosen = new Set(selected)
  const blocks: AgentPromptBlock[] = []

  const index = catalog
    .map((skill) => `- ${skill.name}${skill.description ? `: ${skill.description}` : ''}`)
    .join('\n')
  blocks.push({
    id: SKILLS_INDEX_BLOCK_ID,
    text: `Available skills:\n${index}`
  })

  for (const skill of catalog) {
    if (!chosen.has(skill.name)) continue
    if (!skill.instructions) continue
    blocks.push({
      id: `skill:${skill.name}`,
      text: `Instructions for the ${skill.name} skill:\n${truncate(skill.instructions, maxBodyChars)}`
    })
  }
  return blocks
}

/** Deterministic and explicit: a silently shortened instruction reads as if the
 * skill simply said less than it does. */
function truncate(text: string, maxChars: number) {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}${TRUNCATION_NOTICE}`
}
