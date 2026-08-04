import type { SkillSandboxProvider } from '../../skills/sandbox.ts'
import {
  createDesktopToolExecutor,
  type DesktopToolRuntime
} from '../../tool-sandbox/desktop-executor.ts'
import { WEATHER_SKILL_NAME, WEATHER_TOOL_NAME } from './names.ts'

export function createWeatherSkillSandbox(
  runtime: DesktopToolRuntime = {}
): SkillSandboxProvider {
  return {
    name: WEATHER_SKILL_NAME,
    tools: [WEATHER_TOOL_NAME],
    create({ configuration, scratchRoot }) {
      return createDesktopToolExecutor(
        {
          enabledTools: [WEATHER_TOOL_NAME],
          scratchRoot,
          weather: configuration
        },
        runtime
      )
    }
  }
}
