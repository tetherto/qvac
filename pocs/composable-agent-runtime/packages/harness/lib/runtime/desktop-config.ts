import type { AgentJsonValue } from '@qvac/agents'
import type { HarnessAgentRegistration } from '../agent-registration.ts'
import type { CreateHarnessServiceOptions } from '../harness.ts'
import type { SdkRuntimePort } from '../sdk-runtime-port.ts'
import { composeSkillHost } from '../skills/compose.ts'
import type { SkillHostProvider } from '../skills/host.ts'
import { resolveSkillCatalog, type SkillBundleArtifact } from '../skills/catalog.ts'
import { bundledSkillBundle } from '../skills/index.ts'
import { createImageGenerationSkillHost } from '../skills-impl/image-generation/host.ts'
import { createObsidianSkillHost } from '../skills-impl/obsidian/host.ts'
import { createWeatherSkillHost } from '../skills-impl/weather/host.ts'

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

/**
 * Translates the desktop configuration into the generic skill composition.
 * Which skills exist is decided here, by selecting providers; Harness itself
 * knows only how to compose whatever it is given.
 */
export async function createDesktopHarnessConfiguration(
  sdk: SdkRuntimePort,
  config: HarnessDesktopConfig & { readonly childEntry: string }
): Promise<Omit<CreateHarnessServiceOptions, 'sdk' | 'logging' | 'runStore'>> {
  const registrations = new Map<string, HarnessAgentRegistration>()
  const platform = config.platform ?? DESKTOP_SKILL_PLATFORM
  const bundle: SkillBundleArtifact = bundledSkillBundle()
  const catalog = await resolveSkillCatalog({ bundle, platform })

  const providers: SkillHostProvider[] = []
  const skillConfig: Record<string, Record<string, AgentJsonValue>> = {}
  if (config.weather) {
    providers.push(createWeatherSkillHost())
    skillConfig.weather = { ...config.weather } as Record<string, AgentJsonValue>
  }
  if (config.obsidian) {
    providers.push(createObsidianSkillHost())
    skillConfig.obsidian = { ...config.obsidian } as unknown as Record<string, AgentJsonValue>
  }
  if (config.image) {
    providers.push(createImageGenerationSkillHost())
    skillConfig.image = { ...config.image } as Record<string, AgentJsonValue>
  }

  const composed = await composeSkillHost({
    sdk,
    catalog,
    bundle,
    providers,
    config: {
      ...skillConfig,
      // Provider names are the catalog names, so map the config key across.
      ...(skillConfig.image ? { 'image-generation': skillConfig.image } : {})
    },
    selectedSkillsForAgent(agentId) {
      return registrations.get(agentId)?.skills ?? []
    },
    sandbox: {
      bareExecutable: config.bareExecutable,
      childEntry: config.childEntry,
      ...(config.temporaryRoot ? { temporaryRoot: config.temporaryRoot } : {}),
      ...(config.sandboxIdleTimeoutMs === undefined
        ? {}
        : { idleTimeoutMs: config.sandboxIdleTimeoutMs })
    }
  })

  return {
    ...composed,
    // Without an approval port the gate denies every approval-required call,
    // which made a granted Obsidian exec impossible.
    toolApproval: {
      async approve() {
        return config.obsidianApproval ?? false
      }
    },
    onRegistration(registration) {
      registrations.set(registration.id, registration)
    }
  }
}
