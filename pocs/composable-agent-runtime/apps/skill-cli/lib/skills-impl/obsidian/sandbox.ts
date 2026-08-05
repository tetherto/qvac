import type { SkillSandboxProvider } from '@qvac/harness/skill-sandbox'
import {
  createDesktopToolExecutor,
  type DesktopToolRuntime
} from '../../desktop-executor.ts'
import { OBSIDIAN_SKILL_NAME, OBSIDIAN_TOOL_NAME } from './names.ts'

export function createObsidianSkillSandbox(
  runtime: DesktopToolRuntime = {}
): SkillSandboxProvider {
  return {
    name: OBSIDIAN_SKILL_NAME,
    tools: [OBSIDIAN_TOOL_NAME],
    create({ configuration, scratchRoot }) {
      return createDesktopToolExecutor(
        {
          enabledTools: [OBSIDIAN_TOOL_NAME],
          scratchRoot,
          obsidian: configuration
        },
        runtime
      )
    }
  }
}
