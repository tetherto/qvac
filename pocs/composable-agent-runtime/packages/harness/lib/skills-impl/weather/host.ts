import type { AgentJsonValue, AgentTool } from '@qvac/agents'
import type { SkillHostProvider } from '../../skills/host.ts'
import {
  createWeatherProxy,
  type WeatherFetch
} from '../../tool-sandbox/weather-proxy.ts'
import { WEATHER_SKILL_NAME, WEATHER_TOOL_NAME } from './names.ts'

export { WEATHER_SKILL_NAME, WEATHER_TOOL_NAME } from './names.ts'

export interface WeatherSkillConfig {
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
  readonly maxRedirects?: number
  readonly fetch?: WeatherFetch
}

const HTTP_REQUEST_TOOL: AgentTool = {
  schema: {
    type: 'function',
    name: WEATHER_TOOL_NAME,
    description: 'Get Weather data from the approved wttr.in HTTPS endpoint.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'An HTTPS URL on the exact wttr.in hostname.'
        },
        method: {
          type: 'string',
          enum: ['GET'],
          description: 'Only GET is supported.'
        }
      },
      required: ['url']
    }
  }
}

/**
 * Runs an authenticated loopback proxy in the harness process and grants the
 * sandbox nothing but that one port, so the child never reaches the network.
 */
export function createWeatherSkillHost(
  overrides: WeatherSkillConfig = {}
): SkillHostProvider {
  return {
    name: WEATHER_SKILL_NAME,
    async create({ config }) {
      const proxy = await createWeatherProxy({
        ...readWeatherConfig(config),
        ...overrides
      })
      return {
        tools: [HTTP_REQUEST_TOOL],
        sandboxTools: [WEATHER_TOOL_NAME],
        permissions({ agentId }) {
          return {
            loopbackPorts: [proxy.port],
            enabledTools: [WEATHER_TOOL_NAME],
            configuration() {
              return {
                agentId,
                port: proxy.port,
                token: proxy.tokenForAgent(agentId),
                maxResponseBytes: proxy.maxResponseBytes
              }
            }
          }
        },
        close: () => proxy.close()
      }
    }
  }
}

function readWeatherConfig(config: Readonly<Record<string, AgentJsonValue>>) {
  const timeoutMs = config.timeoutMs
  const maxResponseBytes = config.maxResponseBytes
  const maxRedirects = config.maxRedirects
  return {
    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
    ...(typeof maxResponseBytes === 'number' ? { maxResponseBytes } : {}),
    ...(typeof maxRedirects === 'number' ? { maxRedirects } : {})
  }
}
