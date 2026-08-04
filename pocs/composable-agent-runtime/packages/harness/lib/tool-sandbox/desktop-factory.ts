import fs from '#fs-promises'
import os from '#os'
import path from '#path'
import type { HarnessJsonValue } from '../types.ts'
import type {
  HarnessTool,
  HarnessToolApprovalPort,
  HarnessToolBrokerPort
} from '../tool-broker.ts'
import {
  createSkillCatalogFromBundle,
  type SkillBundleArtifact
} from '../skills/catalog.ts'
import { createSelectedSkillsMaterializer } from '../skills/materialize.ts'
import { parseToolGrant } from '../skills/tool-grants.ts'
import { createDesktopSkillBroker } from './desktop-broker.ts'
import {
  parseObsidianCommand,
  type DesktopToolConfiguration
} from './desktop-executor.ts'
import { createMacOsToolSandboxLauncher } from './macos-launcher.ts'
import { createToolSandboxRegistry } from './registry.ts'
import {
  createWeatherProxy,
  type WeatherFetch
} from './weather-proxy.ts'

const DEFAULT_OBSIDIAN_TIMEOUT_MS = 30_000
const DEFAULT_OBSIDIAN_OUTPUT_BYTES = 8_192
const ELECTRON_APP_BINARY =
  '/Applications/Obsidian.app/Contents/MacOS/Obsidian'
const OBSIDIAN_CLI_SOCKET = () => path.join(os.homedir(), '.obsidian-cli.sock')

export interface CreateMacOsDesktopSkillToolingOptions {
  readonly bareExecutable: string
  readonly childEntry: string
  readonly skillBundle: SkillBundleArtifact
  readonly platform?: string
  readonly selectedSkillsForAgent: (
    agentId: string
  ) => readonly string[] | Promise<readonly string[]>
  readonly sharedBroker?: HarnessToolBrokerPort
  readonly onSandboxEvent?: (
    event:
      | {
          readonly type: 'started'
          readonly agentId: string
          readonly generation: number
          readonly processId: number
        }
      | {
          readonly type: 'exit'
          readonly agentId: string
          readonly generation: number
          readonly code: number | null
          readonly signal: string | null
          readonly expected: boolean
        }
  ) => void
  readonly temporaryRoot?: string
  readonly sandboxIdleTimeoutMs?: number
  readonly weather?: {
    readonly timeoutMs?: number
    readonly maxResponseBytes?: number
    readonly maxRedirects?: number
    readonly fetch?: WeatherFetch
  }
  readonly obsidian?: {
    readonly executablePath: string
    readonly vaultRoot: string
    readonly vaultIdentity: string
    readonly timeoutMs?: number
    readonly maxOutputBytes?: number
    readonly access?: 'read-only' | 'read-write'
    readonly allowedOperations?: readonly string[]
  }
}

export interface MacOsDesktopSkillTooling {
  readonly tools: readonly HarnessTool[]
  readonly broker: HarnessToolBrokerPort
  close(): Promise<void>
}

export async function createMacOsDesktopSkillTooling(
  options: CreateMacOsDesktopSkillToolingOptions
): Promise<MacOsDesktopSkillTooling> {
  const weather = await createWeatherProxy(options.weather)
  const skillMaterializer = createSelectedSkillsMaterializer({
    ...(options.temporaryRoot
      ? { temporaryRoot: options.temporaryRoot }
      : {})
  })
  try {
    const obsidian = options.obsidian
      ? await canonicalObsidianConfiguration(options.obsidian)
      : undefined
    const catalog = await createSkillCatalogFromBundle(
      options.skillBundle,
      options.platform === undefined ? {} : { platform: options.platform }
    )
    const byName = new Map(catalog.map((skill) => [skill.name, skill]))
    const launcher = createMacOsToolSandboxLauncher({
      bareExecutable: options.bareExecutable,
      childEntry: options.childEntry,
      codeRoots: [path.dirname(options.childEntry)],
      executablePaths: [],
      readOnlyRoots: [],
      writeRoots: [],
      ...(options.temporaryRoot
        ? { temporaryRoot: options.temporaryRoot }
        : {}),
      async permissionsForAgent(agentId) {
        const selected = [
          ...new Set(await options.selectedSkillsForAgent(agentId))
        ]
        for (const skillName of selected) {
          if (!byName.has(skillName)) {
            throw new Error(`unknown selected skill: ${skillName}`)
          }
        }
        const grants = selected.flatMap(
          (skillName) => byName.get(skillName)?.tools ?? []
        )
        const weatherEnabled = grants
          .map(parseToolGrant)
          .some((grant) => grant.name === 'http_request')
        const obsidianEnabled = grants
          .map(parseToolGrant)
          .some(
            (grant) =>
              grant.name === 'exec' && grant.scope === 'obsidian'
          )
        if (obsidianEnabled && !obsidian) {
          throw new Error(
            'Obsidian skill selected without explicit CLI and vault configuration'
          )
        }
        const resourceRoot = await skillMaterializer.materialize({
          agentId,
          selectedSkills: selected,
          bundle: options.skillBundle
        })
        return {
          resourceRoots: [resourceRoot],
          executablePaths:
            obsidianEnabled && obsidian
              ? [obsidian.executablePath]
              : [],
          readOnlyRoots:
            obsidianEnabled &&
            obsidian &&
            obsidian.access === 'read-only'
              ? [obsidian.vaultRoot]
              : [],
          writeRoots:
            obsidianEnabled &&
            obsidian &&
            obsidian.access !== 'read-only'
              ? [obsidian.vaultRoot]
              : [],
          loopbackPorts: weatherEnabled ? [weather.port] : [],
          unixSocketPaths:
            obsidianEnabled && obsidian ? [obsidian.cliSocketPath] : [],
          configuration({ scratchRoot }) {
            const enabledTools: ('http_request' | 'exec')[] = []
            if (weatherEnabled) enabledTools.push('http_request')
            if (obsidianEnabled) enabledTools.push('exec')
            const configuration: Record<string, HarnessJsonValue> = {
              enabledTools,
              scratchRoot
            }
            if (weatherEnabled) {
              configuration.weather = {
                agentId,
                port: weather.port,
                token: weather.tokenForAgent(agentId),
                maxResponseBytes: weather.maxResponseBytes
              }
            }
            if (obsidianEnabled && obsidian) {
              configuration.obsidian = {
                executablePath: obsidian.executablePath,
                vaultRoot: obsidian.vaultRoot,
                vaultIdentity: obsidian.vaultIdentity,
                cliSocketPath: obsidian.cliSocketPath,
                timeoutMs: obsidian.timeoutMs,
                maxOutputBytes: obsidian.maxOutputBytes,
                ...(obsidian.allowedOperations
                  ? { allowedOperations: [...obsidian.allowedOperations] }
                  : {})
              }
            }
            return configuration
          }
        }
      }
    })
    const registry = createToolSandboxRegistry({
      launcher,
      ...(options.sandboxIdleTimeoutMs !== undefined
        ? { idleTimeoutMs: options.sandboxIdleTimeoutMs }
        : {}),
      ...(options.onSandboxEvent
        ? {
            onStart(event) {
              options.onSandboxEvent?.({ type: 'started', ...event })
            },
            onExit(event) {
              options.onSandboxEvent?.({
                type: 'exit',
                agentId: event.agentId,
                generation: event.generation,
                code: event.code,
                signal: event.signal,
                expected: event.expected
              })
            }
          }
        : {})
    })
    const routed = createDesktopSkillBroker({
      registry,
      ...(options.sharedBroker
        ? { sharedBroker: options.sharedBroker }
        : {})
    })
    let closed = false
    let closing: Promise<void> | undefined
    const close = async () => {
      if (closed) return
      closing ??= closeResources()
      await closing
    }
    const closeResources = async () => {
      try {
        const results = await Promise.allSettled([
          routed.close(),
          weather.close(),
          skillMaterializer.close()
        ])
        const errors = results.flatMap((result) =>
          result.status === 'rejected'
            ? [toError(result.reason)]
            : []
        )
        if (errors.length === 1) throw errors[0]
        if (errors.length > 1) {
          throw new AggregateError(
            errors,
            'desktop skill tooling close failed'
          )
        }
        closed = true
      } finally {
        closing = undefined
      }
    }
    return {
      tools: [HTTP_REQUEST_TOOL, scopedExecTool(obsidian)],
      broker: {
        execute: routed.execute,
        cancel: routed.cancel,
        close
      },
      close
    }
  } catch (error) {
    try {
      await Promise.all([
        weather.close(),
        skillMaterializer.close()
      ])
    } catch (closeError) {
      throw new AggregateError(
        [toError(error), toError(closeError)],
        'desktop skill tooling setup cleanup failed'
      )
    }
    throw error
  }
}

const HTTP_REQUEST_TOOL: HarnessTool = {
  schema: {
    type: 'function',
    name: 'http_request',
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

const EXEC_TOOL: HarnessTool = {
  schema: {
    type: 'function',
    name: 'exec',
    description:
      'Run one schema-approved Obsidian CLI command after explicit host approval.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'One Obsidian CLI command.'
        }
      },
      required: ['command']
    }
  }
}

async function canonicalObsidianConfiguration(
  input: NonNullable<CreateMacOsDesktopSkillToolingOptions['obsidian']>
): Promise<NonNullable<DesktopToolConfiguration['obsidian']>> {
  const [executablePath, vaultRoot] = await Promise.all([
    fs.realpath(input.executablePath),
    fs.realpath(input.vaultRoot)
  ])
  if (executablePath === ELECTRON_APP_BINARY) {
    throw new Error(
      'the Obsidian Electron app binary is not an approved CLI executable'
    )
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_OBSIDIAN_TIMEOUT_MS
  const maxOutputBytes =
    input.maxOutputBytes ?? DEFAULT_OBSIDIAN_OUTPUT_BYTES
  validatePositiveInteger(timeoutMs, 'Obsidian timeout')
  validatePositiveInteger(maxOutputBytes, 'Obsidian output limit')
  validateVaultIdentity(input.vaultIdentity)
  return {
    executablePath,
    vaultRoot,
    vaultIdentity: input.vaultIdentity,
    cliSocketPath: OBSIDIAN_CLI_SOCKET(),
    timeoutMs,
    maxOutputBytes,
    access: input.access ?? 'read-write',
    ...(input.allowedOperations
      ? { allowedOperations: [...input.allowedOperations] }
      : {})
  }
}

function validateVaultIdentity(value: string) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    throw new Error(
      'Obsidian vault identity must be a non-empty single-line string'
    )
  }
}

function validatePositiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`)
  }
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

function scopedExecTool(
  obsidian: NonNullable<DesktopToolConfiguration['obsidian']> | undefined
): HarnessTool {
  if (!obsidian?.allowedOperations) return EXEC_TOOL
  return {
    ...EXEC_TOOL,
    validateCall(call) {
      const keys = Object.keys(call.arguments)
      if (
        keys.length !== 1 ||
        keys[0] !== 'command' ||
        typeof call.arguments.command !== 'string'
      ) {
        throw new Error('Obsidian exec requires only one command string')
      }
      const parsed = parseObsidianCommand(
        call.arguments.command,
        obsidian.executablePath,
        obsidian.vaultIdentity,
        obsidian.allowedOperations
      )
      if (!parsed.ok) throw new Error(parsed.error)
    }
  }
}
