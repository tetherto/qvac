import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { execPath, versions } from 'node:process'
import semver from 'semver'
import {
  BarePackNotInstalledError,
  BarePackNodeUnsupportedError,
  BarePackError
} from '@/utils/errors-client'
import type { Logger } from '@/logging/types'

const require = createRequire(import.meta.url)

// bare-module-lexer (loaded by bare-pack through bare-module-traverse) calls
// js_is_sharedarraybuffer from its native addon, which older Node lacks; the
// bare-pack child process aborts instead of throwing. Same range as
// engines.node in this package.json and in @qvac/cli.
export const BARE_PACK_NODE_ENGINES = '^22.21.0 || >=24.9.0'

export function isBarePackNodeSupported(version: string): boolean {
  return semver.satisfies(version, BARE_PACK_NODE_ENGINES)
}

// On Node, bare-pack is spawned with this process's execPath, so checking
// process.versions.node checks the Node that will load the lexer. Under Bun,
// process.versions.node is Bun's emulated value and bare-pack runs through its
// shebang in the `node` from PATH, which cannot be checked here.
const runsOnBun = versions['bun'] !== undefined

function assertNodeCanRunBarePack(): void {
  if (runsOnBun) return
  if (isBarePackNodeSupported(versions.node)) return
  throw new BarePackNodeUnsupportedError(versions.node, BARE_PACK_NODE_ENGINES)
}

interface RunBarePackOptions {
  entryPath: string
  outputPath: string
  hosts: string[]
  importsMapPath: string
  deferModules: string[]
  quiet: boolean
  logger: Logger
}

function resolveBarePackBin(): string | null {
  try {
    const barePackPkgPath = require.resolve('bare-pack/package')
    const barePackDir = path.dirname(barePackPkgPath)
    return path.join(barePackDir, 'bin.js')
  } catch {
    return null
  }
}

export async function runBarePack(options: RunBarePackOptions): Promise<void> {
  const { entryPath, outputPath, hosts, importsMapPath, deferModules, quiet, logger } = options

  const barePackBin = resolveBarePackBin()
  if (!barePackBin || !fs.existsSync(barePackBin)) {
    throw new BarePackNotInstalledError()
  }
  assertNodeCanRunBarePack()

  return new Promise((resolve, reject) => {
    const hostArgs = hosts.flatMap((h) => ['--host', h])
    const deferArgs = deferModules.flatMap((m) => ['--defer', m])
    const args = [
      ...hostArgs,
      '--linked',
      '--imports',
      importsMapPath,
      ...deferArgs,
      '--out',
      outputPath,
      entryPath
    ]

    const command = runsOnBun ? barePackBin : execPath
    const spawnArgs = runsOnBun ? args : [barePackBin, ...args]

    logger.debug(`\n📦 Running: ${command} ${spawnArgs.join(' ')}`)

    const proc = spawn(command, spawnArgs, {
      stdio: quiet ? 'ignore' : 'inherit'
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new BarePackError(code ?? 1, entryPath, outputPath))
      }
    })

    proc.on('error', reject)
  })
}
