import type { AgentJsonValue } from '@qvac/agents'
import { createImageGenerationTooling } from '../../image-generation.ts'
import type { SkillHostProvider } from '@qvac/harness/skill-host'

export const IMAGE_SKILL_NAME = 'image-generation'
export const IMAGE_TOOL_NAME = 'generate_image'

export interface ImageSkillConfig {
  readonly attachmentRoot: string
  readonly model: string
  readonly prediction?: 'auto' | 'eps' | 'v' | 'edm_v' | 'flow' | 'flux2_flow'
}

/**
 * Image generation runs in the harness process against the shared SDK runtime
 * rather than in a per-agent sandbox: it needs the model, not a shell.
 */
export function createImageGenerationSkillHost(): SkillHostProvider {
  return {
    name: IMAGE_SKILL_NAME,
    async create({ sdk, config }) {
      const attachmentRoot = config.attachmentRoot
      if (typeof attachmentRoot !== 'string') {
        throw new Error('image generation skill requires an attachment root')
      }
      const tooling = await createImageGenerationTooling({ sdk, attachmentRoot })
      return {
        tools: tooling.tools,
        sharedTools: [IMAGE_TOOL_NAME],
        execute: (input) => tooling.broker.execute(input),
        cancel: (input) => tooling.broker.cancel(input),
        close: () => tooling.close()
      }
    }
  }
}

/** SDK sidecar arguments this skill needs, if any. */
export function imageSdkArgs(
  config: Readonly<Record<string, AgentJsonValue>> | undefined
) {
  if (!config) return []
  const model = config.model
  if (typeof model !== 'string') return []
  return [config]
}
