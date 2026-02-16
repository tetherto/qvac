import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { BarePackNotInstalledError, BarePackError } from '../errors.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function resolveBarePackBin () {
  const binName = process.platform === 'win32' ? 'bare-pack.cmd' : 'bare-pack'
  return path.resolve(__dirname, '..', '..', 'node_modules', '.bin', binName)
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
  if (!fs.existsSync(barePackBin)) {
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
