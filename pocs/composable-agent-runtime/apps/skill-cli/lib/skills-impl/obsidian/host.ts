import fs from '#fs-promises'
import os from '#os'
import path from '#path'
import type { AgentJsonValue, AgentTool } from '@qvac/agents'
import type { SkillHostProvider } from '@qvac/harness/skill-host'
import {
  parseObsidianCommand,
  type DesktopToolConfiguration
} from '../../desktop-executor.ts'
import { OBSIDIAN_SKILL_NAME, OBSIDIAN_TOOL_NAME } from './names.ts'

export { OBSIDIAN_SKILL_NAME, OBSIDIAN_TOOL_NAME } from './names.ts'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_OUTPUT_BYTES = 8_192
const ELECTRON_APP_BINARY = '/Applications/Obsidian.app/Contents/MacOS/Obsidian'
const CLI_SOCKET = () => path.join(os.homedir(), '.obsidian-cli.sock')

export interface ObsidianSkillConfig {
  readonly executablePath: string
  readonly vaultRoot: string
  readonly vaultIdentity: string
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly access?: 'read-only' | 'read-write'
  readonly allowedOperations?: readonly string[]
}

const EXEC_TOOL: AgentTool = {
  schema: {
    type: 'function',
    name: OBSIDIAN_TOOL_NAME,
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

export function createObsidianSkillHost(): SkillHostProvider {
  return {
    name: OBSIDIAN_SKILL_NAME,
    async create({ config }) {
      const obsidian = await canonicalConfiguration(readConfig(config))
      return {
        tools: [scopedExecTool(obsidian)],
        sandboxTools: [OBSIDIAN_TOOL_NAME],
        // Executing a CLI is side-effecting, so approval is not left to the
        // agent's own policy.
        requiresApproval: [OBSIDIAN_TOOL_NAME],
        permissions() {
          return {
            executablePaths: [obsidian.executablePath],
            ...(obsidian.access === 'read-only'
              ? { readOnlyRoots: [obsidian.vaultRoot] }
              : { writeRoots: [obsidian.vaultRoot] }),
            unixSocketPaths: [obsidian.cliSocketPath],
            enabledTools: [OBSIDIAN_TOOL_NAME],
            configuration() {
              return {
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
          }
        }
      }
    }
  }
}

function readConfig(config: Readonly<Record<string, AgentJsonValue>>): ObsidianSkillConfig {
  const executablePath = config.executablePath
  const vaultRoot = config.vaultRoot
  const vaultIdentity = config.vaultIdentity
  if (
    typeof executablePath !== 'string' ||
    typeof vaultRoot !== 'string' ||
    typeof vaultIdentity !== 'string'
  ) {
    throw new Error(
      'Obsidian skill selected without explicit CLI and vault configuration'
    )
  }
  const access = config.access === 'read-only' ? 'read-only' : undefined
  const allowed = config.allowedOperations
  return {
    executablePath,
    vaultRoot,
    vaultIdentity,
    ...(typeof config.timeoutMs === 'number' ? { timeoutMs: config.timeoutMs } : {}),
    ...(typeof config.maxOutputBytes === 'number'
      ? { maxOutputBytes: config.maxOutputBytes }
      : {}),
    ...(access ? { access } : {}),
    ...(Array.isArray(allowed)
      ? { allowedOperations: allowed.filter((value): value is string => typeof value === 'string') }
      : {})
  }
}

export async function canonicalConfiguration(
  input: ObsidianSkillConfig
): Promise<NonNullable<DesktopToolConfiguration['obsidian']>> {
  const [executablePath, vaultRoot] = await Promise.all([
    fs.realpath(input.executablePath),
    fs.realpath(input.vaultRoot)
  ])
  if (executablePath === ELECTRON_APP_BINARY) {
    throw new Error('the Obsidian Electron app binary is not an approved CLI executable')
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES
  validatePositiveInteger(timeoutMs, 'Obsidian timeout')
  validatePositiveInteger(maxOutputBytes, 'Obsidian output limit')
  validateVaultIdentity(input.vaultIdentity)
  return {
    executablePath,
    vaultRoot,
    vaultIdentity: input.vaultIdentity,
    cliSocketPath: CLI_SOCKET(),
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
    throw new Error('Obsidian vault identity must be a non-empty single-line string')
  }
}

function validatePositiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`)
  }
}

function scopedExecTool(
  obsidian: NonNullable<DesktopToolConfiguration['obsidian']>
): AgentTool {
  if (!obsidian.allowedOperations) return EXEC_TOOL
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
