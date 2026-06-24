import os from 'node:os'
import { spawnSync } from 'node:child_process'
import type { CheckResult } from './types.js'

export interface ProbeResult {
  ok: boolean
  version?: string
  // Full trimmed stdout. Checks that only need a version line use
  // `version` (first line); checks that need to parse multi-line output
  // — e.g. `vulkaninfo --summary` device names — read `stdout`.
  stdout?: string
}

export type ProbeFn = (command: string, args: string[]) => ProbeResult

// Read once at context creation rather than from each check so checks
// are pure functions of CheckContext. This is the contract that makes
// tests deterministic: build a context with the inputs you care about,
// invoke the check, assert the result.
export interface CheckContext {
  projectRoot: string
  platform: NodeJS.Platform
  arch: string
  nodeVersion: string
  totalMemoryBytes: number
  availableMemoryBytes: number
  probe: ProbeFn
}

export type Check = (ctx: CheckContext) => CheckResult

// Cap probes at 3s so a hung/interactive binary (or an adb that is
// waiting for a device) cannot make `qvac doctor` hang. 3s is generous
// for a `--version` style call while still short enough to keep the
// command snappy.
const PROBE_TIMEOUT_MS = 3000

export const probeBinary: ProbeFn = (command, args) => {
  try {
    const r = spawnSync(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PROBE_TIMEOUT_MS
    })
    if (r.error || r.status !== 0 || r.signal === 'SIGTERM') return { ok: false }
    const stdout = r.stdout.toString('utf8').trim()
    const firstLine = stdout.split('\n')[0]?.trim() ?? ''
    const result: ProbeResult = { ok: true }
    if (firstLine) result.version = firstLine
    if (stdout) result.stdout = stdout
    return result
  } catch {
    return { ok: false }
  }
}

// Prefer os.availableMemory() (Node 22+) which reports memory actually
// available for allocation. os.freemem() is known to be misleading on
// Linux and macOS because it excludes reclaimable page cache, which
// causes noisy false warnings on otherwise healthy systems.
function readAvailableMemoryBytes (): number {
  const available = (os as unknown as { availableMemory?: () => number }).availableMemory
  if (typeof available === 'function') return available()
  return os.freemem()
}

export function createDefaultContext (projectRoot: string = process.cwd()): CheckContext {
  return {
    projectRoot,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    totalMemoryBytes: os.totalmem(),
    availableMemoryBytes: readAvailableMemoryBytes(),
    probe: probeBinary
  }
}
