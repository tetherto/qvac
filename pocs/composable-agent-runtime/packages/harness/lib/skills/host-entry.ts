import Buffer from '#buffer'
import process from '#process'
import { createChildEntry } from '../child-entry.ts'
import { createSdkSidecarAdapter } from '../sdk-sidecar-adapter.ts'
import { installHarnessConfigFromArgv } from '../config.ts'
import type { HarnessRuntimeInfo } from '../connect.ts'
import type { HarnessStream } from '../transport.ts'
import { harnessCompatibility } from '../runtime/compatibility.ts'
import type { WireHostConfig } from '../runtime/host-config.ts'
import { resolveSkillCatalog, type SkillBundleArtifact } from './catalog.ts'
import { composeSkillHost } from './compose.ts'
import type { SkillHostProvider } from './host.ts'

// Never hash-verified, because it is never materialized.
const EMPTY_BUNDLE: SkillBundleArtifact = { files: {}, hash: '' }

export interface CreateHarnessChildEntryOptions {
  readonly skills: readonly SkillHostProvider[]
  /** Omit for a worker with no skills; a bundle is always hash-verified. */
  readonly skillBundle?: SkillBundleArtifact
  /** Extra arguments for the SDK sidecar, derived from a skill's config slice. */
  readonly sdkArgs?: (config: WireHostConfig) => readonly string[]
}

/**
 * Builds a harness worker entry from skill providers.
 *
 * Applications own the entry module because the bundler follows static imports,
 * but not the runtime identity: protocol version and capabilities are taken
 * from the compatibility contract, so an application cannot drift from the
 * handshake the host asserts.
 */
export function createHarnessChildEntry({
  skills,
  skillBundle,
  sdkArgs
}: CreateHarnessChildEntryOptions) {
  const sdkEntry = argument('--sdk-entry=')
  const hostConfig = parseHostConfig(argument('--host-config='))
  installHarnessConfigFromArgv(process.argv)
  let sdkIdentity: HarnessRuntimeInfo | undefined

  const startChild = createChildEntry({
    async configure(sdk) {
      const platform = hostConfig?.platform
      const bundle: SkillBundleArtifact = skillBundle ?? EMPTY_BUNDLE
      const catalog = skillBundle
        ? await resolveSkillCatalog({
            bundle,
            ...(platform === undefined ? {} : { platform })
          })
        : []
      const registrations = new Map<string, readonly string[]>()
      const composed = await composeSkillHost({
        sdk,
        catalog,
        bundle,
        providers: skills,
        ...(hostConfig?.skills ? { config: hostConfig.skills } : {}),
        selectedSkillsForAgent: (agentId) => registrations.get(agentId) ?? [],
        ...(hostConfig?.sandboxChildEntry
          ? {
              sandbox: {
                bareExecutable: hostConfig.bareExecutable ?? '',
                childEntry: hostConfig.sandboxChildEntry,
                ...(hostConfig.temporaryRoot
                  ? { temporaryRoot: hostConfig.temporaryRoot }
                  : {}),
                ...(hostConfig.sandboxIdleTimeoutMs === undefined
                  ? {}
                  : { idleTimeoutMs: hostConfig.sandboxIdleTimeoutMs })
              }
            }
          : {})
      })
      return {
        ...composed,
        onRegistration(registration) {
          registrations.set(registration.id, registration.skills)
        }
      }
    },
    async createSdk() {
      if (!sdkEntry) throw new Error('Harness requires --sdk-entry')
      const extra = hostConfig && sdkArgs ? sdkArgs(hostConfig) : []
      return createSdkSidecarAdapter({
        entry: sdkEntry,
        ...(extra.length > 0 ? { args: [...extra] } : {}),
        onIdentity(identity) {
          sdkIdentity = identity
        }
      })
    },
    describeRuntime: () => ({
      component: harnessCompatibility.component,
      runtime: 'bare',
      instanceId: `harness-${process.pid}`,
      processId: process.pid,
      contract: harnessCompatibility.contract,
      protocolVersion: harnessCompatibility.protocolVersion,
      capabilities: [...harnessCompatibility.capabilities],
      buildVersion: harnessCompatibility.buildVersion,
      ...(sdkIdentity === undefined
        ? {}
        : {
            sdkIdentity: {
              component: sdkIdentity.component,
              runtime: sdkIdentity.runtime,
              instanceId: sdkIdentity.instanceId,
              processId: sdkIdentity.processId,
              buildVersion: sdkIdentity.buildVersion
            }
          })
    })
  })

  return async function start(stream: HarnessStream, ready?: () => void) {
    const stop = await startChild(stream)
    ready?.()
    return stop
  }
}

function argument(prefix: string) {
  return process.argv
    .find((value: string) => value.startsWith(prefix))
    ?.slice(prefix.length)
}

function parseHostConfig(encoded: string | undefined): WireHostConfig | undefined {
  if (!encoded) return undefined
  return JSON.parse(Buffer.from(encoded, 'base64').toString()) as WireHostConfig
}
