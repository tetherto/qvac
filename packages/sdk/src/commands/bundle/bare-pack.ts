import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { platform, execPath, versions } from 'node:process'
import semver from 'semver'
import {
  BarePackNotInstalledError,
  BarePackNodeUnsupportedError,
  BarePackError
} from '@/utils/errors-client'
import type { Logger } from '@/logging/types'

const require = createRequire(import.meta.url)

// bare-module-lexer (loaded by bare-pack through bare-module-traverse) calls
// js_is_sharedarraybuffer from its native addon, which Node outside this range
// lacks; the bare-pack child process crashes instead of throwing. Same range as
// engines.node in @qvac/cli.
export const BARE_PACK_NODE_ENGINES = '^22.21.0 || >=24.9.0'

export function isBarePackNodeSupported(version: string): boolean {
  return semver.satisfies(version, BARE_PACK_NODE_ENGINES, { includePrerelease: true })
}

interface NodeVersions {
  node: string
  bun?: string | undefined
}

interface RunBarePackOptions {
  entryPath: string
  outputPath: string
  hosts: string[]
  importsMapPath: string
  deferModules: string[]
  quiet: boolean
  logger: Logger
  /** The runtime running bare-pack; defaults to this process. Tests inject an older Node. */
  nodeVersions?: NodeVersions | undefined
}

// On Node, bare-pack is spawned with this process's execPath, so checking
// process.versions.node checks the Node that will load the lexer. Under Bun,
// process.versions.node is Bun's emulated value and, except on Windows, bare-pack
// runs through its shebang in the `node` from PATH, which cannot be checked here.
function assertNodeCanRunBarePack(nodeVersions: NodeVersions): void {
  if (nodeVersions.bun !== undefined) return
  if (isBarePackNodeSupported(nodeVersions.node)) return
  throw new BarePackNodeUnsupportedError(nodeVersions.node, BARE_PACK_NODE_ENGINES)
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
  const nodeVersions = options.nodeVersions ?? versions

  const barePackBin = resolveBarePackBin()
  if (!barePackBin || !fs.existsSync(barePackBin)) {
    throw new BarePackNotInstalledError()
  }
  assertNodeCanRunBarePack(nodeVersions)

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

    // Windows cannot exec a .js file directly, so it always goes through execPath.
    const viaShebang = nodeVersions.bun !== undefined && platform !== 'win32'
    const command = viaShebang ? barePackBin : execPath
    const spawnArgs = viaShebang ? args : [barePackBin, ...args]

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
