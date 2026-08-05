import { hashBundledSkills } from '../lib/skills/index.ts'

/**
 * Harness owns generic skill machinery, not any particular skill. Its tests
 * therefore drive a synthetic bundle rather than whichever skills an
 * application happens to ship.
 */
function skillManifest(input: {
  readonly name: string
  readonly description: string
  readonly tools: readonly string[]
}) {
  return [
    '---',
    `name: ${input.name}`,
    `description: ${input.description}`,
    `tools: [${input.tools.join(', ')}]`,
    '---',
    '',
    `# ${input.name}`,
    '',
    `Fixture instructions for the ${input.name} skill.`,
    ''
  ].join('\n')
}

const FIXTURE_FILES: Record<string, string> = {
  'weather/SKILL.md': skillManifest({
    name: 'weather',
    description: 'Fixture skill granting an HTTP request tool.',
    tools: ['http_request']
  }),
  'image-generation/SKILL.md': skillManifest({
    name: 'image-generation',
    description: 'Fixture skill granting an image generation tool.',
    tools: ['generate_image']
  }),
  'notes/SKILL.md': skillManifest({
    name: 'notes',
    description: 'Fixture skill granting a scoped exec tool.',
    tools: ['exec(notes)']
  }),
  'danger/SKILL.md': skillManifest({
    name: 'danger',
    description: 'Fixture skill granting a tool that should require approval.',
    tools: ['danger']
  })
}

export function fixtureSkillBundle() {
  return { files: FIXTURE_FILES, hash: hashBundledSkills(FIXTURE_FILES) }
}

export function fixtureSkills() {
  return { bundle: fixtureSkillBundle() }
}
