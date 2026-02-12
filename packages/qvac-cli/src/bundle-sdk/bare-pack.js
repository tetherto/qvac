import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { BarePackNotInstalledError, BarePackError } from '../errors.js'

function resolveBarePackBin (projectRoot) {
  const binName = process.platform === 'win32' ? 'bare-pack.cmd' : 'bare-pack'
  return path.join(projectRoot, 'node_modules', '.bin', binName)
}

async function detectBarePackMajorVersion (barePackBin, entryPath) {
  return new Promise((resolve) => {
    const proc = spawn(barePackBin, ['--version', entryPath], {
      stdio: ['ignore', 'pipe', 'ignore']
    })

    let output = ''
    proc.stdout.on('data', (data) => {
      output += data.toString()
    })

    proc.on('close', () => {
      const match = output.match(/v?(\d+)\./)
      const majorVersion = match?.[1] ? parseInt(match[1], 10) : 2
      resolve(majorVersion)
    })

    proc.on('error', () => resolve(2)) // Default to v2 on error
  })
}

export async function runBarePack (options) {
  const {
    projectRoot,
    entryPath,
    outputPath,
    hosts,
    importsMapPath,
    deferModules,
    logLevel,
    logger
  } = options

  const barePackBin = resolveBarePackBin(projectRoot)
  if (!fs.existsSync(barePackBin)) {
    throw new BarePackNotInstalledError()
  }

  const majorVersion = await detectBarePackMajorVersion(barePackBin, entryPath)
  const platformFlag = majorVersion < 2 ? '--target' : '--host'
  logger.debug(
    `📦 Detected bare-pack v${majorVersion} (using ${platformFlag})`
  )

  return new Promise((resolve, reject) => {
    const hostArgs = hosts.flatMap((h) => [platformFlag, h])
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

    logger.debug(`\n📦 Running: ${barePackBin} ${args.join(' ')}`)

    const proc = spawn(barePackBin, args, {
      stdio: logLevel === 'silent' ? 'ignore' : 'inherit'
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
