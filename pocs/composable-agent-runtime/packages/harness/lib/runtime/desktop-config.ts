import type { HarnessAgentRegistration } from '../agent-registration.ts'
import type { CreateHarnessServiceOptions } from '../harness.ts'
import { createImageGenerationTooling } from '../image-generation.ts'
import type { SdkRuntimePort } from '../sdk-runtime-port.ts'
import { bundledSkillBundle } from '../skills/index.ts'
import { createMacOsDesktopSkillTooling } from '../tool-sandbox/desktop-factory.ts'

const DESKTOP_SKILL_PLATFORM = 'darwin'

export interface HarnessDesktopConfig {
  readonly bareExecutable: string
  readonly platform?: string
  readonly temporaryRoot?: string
  readonly sandboxIdleTimeoutMs?: number
  readonly obsidianApproval?: boolean
  readonly obsidian?: {
    readonly executablePath: string
    readonly vaultRoot: string
    readonly vaultIdentity: string
    readonly timeoutMs?: number
    readonly maxOutputBytes?: number
    readonly access?: 'read-only' | 'read-write'
    readonly allowedOperations?: readonly string[]
  }
  readonly weather?: {
    readonly timeoutMs?: number
    readonly maxResponseBytes?: number
    readonly maxRedirects?: number
  }
  readonly image?: {
    readonly attachmentRoot: string
    readonly model: string
    readonly prediction?: 'auto' | 'eps' | 'v' | 'edm_v' | 'flow' | 'flux2_flow'
  }
}

export async function createDesktopHarnessConfiguration(
  sdk: SdkRuntimePort,
  config: HarnessDesktopConfig & { readonly childEntry: string }
): Promise<Omit<CreateHarnessServiceOptions, 'sdk' | 'logging' | 'runStore'>> {
  const registrations = new Map<string, HarnessAgentRegistration>()
  const platform = config.platform ?? DESKTOP_SKILL_PLATFORM
  const skillBundle = bundledSkillBundle()
  const image = config.image
    ? await createImageGenerationTooling({
        sdk,
        attachmentRoot: config.image.attachmentRoot
      })
    : undefined
  const desktop =
    config.weather || config.obsidian
      ? await createMacOsDesktopSkillTooling({
          bareExecutable: config.bareExecutable,
          childEntry: config.childEntry,
          skillBundle,
          platform,
          selectedSkillsForAgent(agentId) {
            return registrations.get(agentId)?.skills ?? []
          },
          approval: {
            async approve() {
              return config.obsidianApproval ?? false
            }
          },
          ...(image ? { sharedBroker: image.broker } : {}),
          ...(config.temporaryRoot
            ? { temporaryRoot: config.temporaryRoot }
            : {}),
          ...(config.sandboxIdleTimeoutMs === undefined
            ? {}
            : { sandboxIdleTimeoutMs: config.sandboxIdleTimeoutMs }),
          ...(config.weather ? { weather: config.weather } : {}),
          ...(config.obsidian ? { obsidian: config.obsidian } : {})
        })
      : undefined
  return {
    skills: { bundle: skillBundle, platform },
    tools: [
      ...(desktop?.tools ?? []),
      ...(image?.tools ?? [])
    ],
    toolBroker:
      desktop?.broker ??
      image?.broker ??
      unavailableToolBroker(),
    onRegistration(registration) {
      registrations.set(registration.id, registration)
    }
  }
}

function unavailableToolBroker() {
  return {
    async execute(input: { readonly call: { readonly name: string } }) {
      throw new Error(`no tool broker configured for ${input.call.name}`)
    },
    async cancel() {},
    async close() {}
  }
}
