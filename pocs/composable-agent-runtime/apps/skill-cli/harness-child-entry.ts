import { createHarnessChildEntry } from '@qvac/harness/skill-host'
import Buffer from 'bare-buffer'
import { BUNDLED_SKILLS, BUNDLED_SKILLS_HASH } from './lib/skills/bundled-skills.ts'
import { createImageGenerationSkillHost } from './lib/skills-impl/image-generation/host.ts'
import { createObsidianSkillHost } from './lib/skills-impl/obsidian/host.ts'
import { createWeatherSkillHost } from './lib/skills-impl/weather/host.ts'

/**
 * This application's harness worker. The bundler follows these static imports,
 * so this list is what the worker can serve.
 */
export default createHarnessChildEntry({
  skills: [
    createWeatherSkillHost(),
    createObsidianSkillHost(),
    createImageGenerationSkillHost()
  ],
  skillBundle: { files: BUNDLED_SKILLS, hash: BUNDLED_SKILLS_HASH },
  sdkArgs(config) {
    const image = config.skills?.['image-generation']
    if (!image) return []
    return [
      `--diffusion-config=${Buffer.from(JSON.stringify(image)).toString('base64')}`
    ]
  }
})
