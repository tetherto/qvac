import type { AgentJsonValue, ToolGrant } from '@qvac/agents'
import type { HarnessAgentRegistration } from '../agent-registration.ts'
import type { CreateHarnessServiceOptions } from '../harness.ts'
import type { SdkRuntimePort } from '../sdk-runtime-port.ts'
import { createSandboxToolBroker } from '../tool-sandbox/broker.ts'
import { createMacOsToolSandboxLauncher } from '../tool-sandbox/macos-launcher.ts'
import type { ToolSandboxLauncher } from '../tool-sandbox/types.ts'
import { createToolSandboxRegistry } from '../tool-sandbox/registry.ts'
import type { HarnessToolBrokerPort } from '../tool-broker.ts'
import type { SkillBundleArtifact, SkillCatalogEntry } from './catalog.ts'
import type { SkillHostContribution, SkillHostProvider } from './host.ts'
import { createSelectedSkillsMaterializer } from './materialize.ts'
import { parseToolGrant } from './tool-grants.ts'
import path from '#path'

export interface ComposeSkillHostOptions {
  readonly sdk: SdkRuntimePort
  readonly catalog: readonly SkillCatalogEntry[]
  readonly bundle: SkillBundleArtifact
  readonly providers: readonly SkillHostProvider[]
  /** Per-skill opaque configuration, keyed by skill name. */
  readonly config?: Readonly<Record<string, Record<string, AgentJsonValue>>>
  readonly selectedSkillsForAgent: (
    agentId: string
  ) => readonly string[] | Promise<readonly string[]>
  readonly sandbox?: {
    readonly bareExecutable: string
    readonly childEntry: string
    readonly temporaryRoot?: string
    readonly idleTimeoutMs?: number
    /** Overrides the platform launcher; used by tests and future backends. */
    readonly launcher?: ToolSandboxLauncher
  }
}

export type ComposedSkillHost = Omit<
  CreateHarnessServiceOptions,
  'sdk' | 'logging' | 'runStore'
> & {
  close(): Promise<void>
}

/**
 * Composes application-supplied skills into the options a harness service
 * needs. Harness knows nothing about any particular skill: which tools exist,
 * where they run, and what the sandbox must permit all come from providers.
 */
export async function composeSkillHost(
  options: ComposeSkillHostOptions
): Promise<ComposedSkillHost> {
  const contributions = new Map<string, SkillHostContribution>()
  try {
    return await compose(options, contributions)
  } catch (error) {
    // A provider that already ran create() may hold a listening socket or a
    // child process. Failing to compose must not strand them, and a rollback
    // failure must not replace the reason composition failed.
    await Promise.allSettled(
      [...contributions.values()].map((contribution) => contribution.close?.())
    )
    throw error
  }
}

async function compose(
  options: ComposeSkillHostOptions,
  contributions: Map<string, SkillHostContribution>
): Promise<ComposedSkillHost> {
  const byName = new Map(options.catalog.map((entry) => [entry.name, entry]))
  const toolOwners = new Map<string, string>()
  const sandboxTools = new Set<string>()
  const sharedOwners = new Map<string, SkillHostContribution>()
  const mandatoryApproval = new Set<string>()

  for (const provider of options.providers) {
    const entry = byName.get(provider.name)
    // A provider without a catalog entry can never be selected, so wiring it
    // up would silently do nothing.
    if (!entry) throw new Error(`skill provider has no catalog entry: ${provider.name}`)
    const contribution = await provider.create({
      sdk: options.sdk,
      entry,
      config: options.config?.[provider.name] ?? {},
      ...(options.sandbox?.temporaryRoot
        ? { temporaryRoot: options.sandbox.temporaryRoot }
        : {})
    })
    contributions.set(provider.name, contribution)
    for (const tool of contribution.tools) {
      const owner = toolOwners.get(tool.schema.name)
      if (owner) {
        throw new Error(
          `duplicate tool "${tool.schema.name}" from skills ${owner} and ${provider.name}`
        )
      }
      toolOwners.set(tool.schema.name, provider.name)
    }
    for (const tool of contribution.sandboxTools ?? []) sandboxTools.add(tool)
    for (const tool of contribution.sharedTools ?? []) {
      sharedOwners.set(tool, contribution)
    }
    for (const tool of contribution.requiresApproval ?? []) {
      mandatoryApproval.add(tool)
    }
  }

  const tools = [...contributions.values()].flatMap(
    (contribution) => contribution.tools
  )
  const sharedBroker = createSharedBroker(sharedOwners)

  if (sandboxTools.size === 0) {
    return {
      skills: { catalog: options.catalog },
      tools,
      toolBroker: sharedBroker,
      ...(mandatoryApproval.size > 0
        ? { mandatoryApproval: [...mandatoryApproval] }
        : {}),
      close: () => closeAll(contributions)
    }
  }

  const sandbox = options.sandbox
  if (!sandbox) {
    throw new Error(
      `skills require a sandbox for tools: ${[...sandboxTools].sort().join(', ')}`
    )
  }

  const materializer = createSelectedSkillsMaterializer({
    ...(sandbox.temporaryRoot ? { temporaryRoot: sandbox.temporaryRoot } : {})
  })
  const launcher = sandbox.launcher ?? createMacOsToolSandboxLauncher({
    bareExecutable: sandbox.bareExecutable,
    childEntry: sandbox.childEntry,
    codeRoots: [path.dirname(sandbox.childEntry)],
    executablePaths: [],
    readOnlyRoots: [],
    writeRoots: [],
    ...(sandbox.temporaryRoot ? { temporaryRoot: sandbox.temporaryRoot } : {}),
    async permissionsForAgent(agentId) {
      const selected = [...new Set(await options.selectedSkillsForAgent(agentId))]
      for (const name of selected) {
        if (!byName.has(name)) throw new Error(`unknown selected skill: ${name}`)
      }
      const merged = await mergeContributions({
        agentId,
        selected,
        byName,
        contributions
      })
      const resourceRoot = await materializer.materialize({
        agentId,
        selectedSkills: selected,
        bundle: options.bundle
      })
      return {
        resourceRoots: [resourceRoot],
        executablePaths: merged.executablePaths,
        readOnlyRoots: merged.readOnlyRoots,
        writeRoots: merged.writeRoots,
        loopbackPorts: merged.loopbackPorts,
        unixSocketPaths: merged.unixSocketPaths,
        configuration({ scratchRoot }) {
          const skills: Record<string, Record<string, AgentJsonValue>> = {}
          for (const [name, contribute] of merged.configure) {
            skills[name] = contribute({ scratchRoot, agentId })
          }
          return {
            scratchRoot,
            enabledTools: merged.enabledTools,
            skills
          } as unknown as Record<string, AgentJsonValue>
        }
      }
    }
  })
  const registry = createToolSandboxRegistry({
    launcher,
    ...(sandbox.idleTimeoutMs === undefined
      ? {}
      : { idleTimeoutMs: sandbox.idleTimeoutMs })
  })
  const routed = requireDeclaredGrants(
    createSandboxToolBroker({
      registry,
      sandboxTools: [...sandboxTools],
      sharedBroker
    }),
    requiredGrantsFor(options.providers, byName)
  )

  return {
    skills: { catalog: options.catalog },
    tools,
    toolBroker: routed,
    ...(mandatoryApproval.size > 0
      ? { mandatoryApproval: [...mandatoryApproval] }
      : {}),
    async close() {
      // Materialized skill trees are mode 0500, so only the materializer can
      // remove them. Leaving them behind breaks any caller that cleans up its
      // own temporary root.
      const results = await Promise.allSettled([
        routed.close(),
        materializer.close(),
        closeAll(contributions)
      ])
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    }
  }
}

async function mergeContributions(input: {
  readonly agentId: string
  readonly selected: readonly string[]
  readonly byName: ReadonlyMap<string, SkillCatalogEntry>
  readonly contributions: ReadonlyMap<string, SkillHostContribution>
}) {
  const executablePaths: string[] = []
  const readOnlyRoots: string[] = []
  const writeRoots: string[] = []
  const loopbackPorts: number[] = []
  const unixSocketPaths: string[] = []
  const enabledTools: string[] = []
  const configure = new Map<
    string,
    (paths: { readonly scratchRoot: string; readonly agentId: string }) => Record<
      string,
      AgentJsonValue
    >
  >()

  for (const name of input.selected) {
    const contribution = input.contributions.get(name)
    if (!contribution?.permissions) continue
    const grants: ToolGrant[] = (input.byName.get(name)?.tools ?? []).map(parseToolGrant)
    const contributed = await contribution.permissions({ agentId: input.agentId, grants })
    executablePaths.push(...(contributed.executablePaths ?? []))
    readOnlyRoots.push(...(contributed.readOnlyRoots ?? []))
    writeRoots.push(...(contributed.writeRoots ?? []))
    loopbackPorts.push(...(contributed.loopbackPorts ?? []))
    unixSocketPaths.push(...(contributed.unixSocketPaths ?? []))
    enabledTools.push(...(contributed.enabledTools ?? []))
    const configuration = contributed.configuration
    if (configuration) {
      configure.set(name, (paths) => ({ ...configuration(paths) }))
    }
  }

  return {
    executablePaths: unique(executablePaths),
    readOnlyRoots: unique(readOnlyRoots),
    writeRoots: unique(writeRoots),
    loopbackPorts: [...new Set(loopbackPorts)],
    unixSocketPaths: unique(unixSocketPaths),
    enabledTools: unique(enabledTools),
    configure
  }
}

/**
 * A skill's SKILL.md states the grant each of its tools needs, scope included.
 * Collect those so an invocation can be checked against what the skill confers
 * rather than against the bare tool name.
 */
function requiredGrantsFor(
  providers: readonly SkillHostProvider[],
  byName: ReadonlyMap<string, SkillCatalogEntry>
) {
  const required = new Map<string, ToolGrant[]>()
  const owners = new Map<string, string>()
  for (const provider of providers) {
    for (const raw of byName.get(provider.name)?.tools ?? []) {
      const grant = parseToolGrant(raw)
      // Two skills declaring the same grant name would each satisfy the
      // other's scope check, so one skill's grant could unlock another's tool.
      const owner = owners.get(grant.name)
      if (owner && owner !== provider.name) {
        throw new Error(
          `duplicate grant "${grant.name}" from skills ${owner} and ${provider.name}`
        )
      }
      owners.set(grant.name, provider.name)
      const existing = required.get(grant.name) ?? []
      existing.push(grant)
      required.set(grant.name, existing)
    }
  }
  return required
}

/**
 * Fails closed when an invocation lacks the scoped grant its skill declares.
 * The agents gate checks that a tool is granted by name; only the skill knows
 * that "exec" without its scope is a different capability.
 */
function requireDeclaredGrants(
  broker: HarnessToolBrokerPort,
  required: ReadonlyMap<string, readonly ToolGrant[]>
): HarnessToolBrokerPort {
  return {
    async execute(input) {
      const expected = required.get(input.call.name)
      if (expected?.length) {
        const satisfied = expected.some((want) =>
          input.grants.some(
            (held) => held.name === want.name && held.scope === want.scope
          )
        )
        if (!satisfied) {
          throw new Error(`tool is not granted with its required scope: ${input.call.name}`)
        }
      }
      if (input.signal.aborted) throw new Error('tool call aborted')
      return broker.execute(input)
    },
    cancel: (input) => broker.cancel(input),
    close: () => broker.close()
  }
}

function createSharedBroker(
  owners: ReadonlyMap<string, SkillHostContribution>
): HarnessToolBrokerPort {
  return {
    async execute(input) {
      const contribution = owners.get(input.call.name)
      if (!contribution?.execute) {
        throw new Error(`no tool broker configured for ${input.call.name}`)
      }
      return contribution.execute(input)
    },
    async cancel(input) {
      const seen = new Set<SkillHostContribution>()
      for (const contribution of owners.values()) {
        if (seen.has(contribution)) continue
        seen.add(contribution)
        await contribution.cancel?.(input)
      }
    },
    async close() {}
  }
}

async function closeAll(
  contributions: ReadonlyMap<string, SkillHostContribution>
) {
  const results = await Promise.allSettled(
    [...contributions.values()].map((contribution) => contribution.close?.())
  )
  const failure = results.find((result) => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}

function unique(values: readonly string[]) {
  return [...new Set(values)]
}
