import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { BarePackNotInstalledError, BarePackError } from '../errors.js'

const require = createRequire(import.meta.url)

function resolveBarePackBin () {
  try {
    const barePackPkgPath = require.resolve('bare-pack/package')
    const barePackDir = path.dirname(barePackPkgPath)
    return path.join(barePackDir, 'bin.js')
  } catch {
    return null
  }
}

export async function runBarePack (options) {
  const {
    entryPath,
    outputPath,
    hosts,
    importsMapPath,
    deferModules,
    logLevel,
    logger
  } = options

  const barePackBin = resolveBarePackBin()
  if (!barePackBin || !fs.existsSync(barePackBin)) {
    throw new BarePackNotInstalledError()
  }

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
