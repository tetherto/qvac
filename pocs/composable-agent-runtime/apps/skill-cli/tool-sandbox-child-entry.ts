import { createToolSandboxChildEntry } from '@qvac/harness/skill-sandbox'
import { createObsidianSkillSandbox } from './lib/skills-impl/obsidian/sandbox.ts'
import { createWeatherSkillSandbox } from './lib/skills-impl/weather/sandbox.ts'

/**
 * This application's sandbox worker. Only the in-sandbox halves are imported:
 * pulling in a host half would drag the outbound HTTPS transport and the
 * attachment filesystem into the sandboxed bundle.
 */
export default createToolSandboxChildEntry({
  skills: [createWeatherSkillSandbox(), createObsidianSkillSandbox()]
})
