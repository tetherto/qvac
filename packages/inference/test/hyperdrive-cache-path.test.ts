import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { isConfigSet, setConfig } from '@/runtime/state'
import { downloadModelFromHyperdrive } from '@/handlers/load-model/hyperdrive'
import { PathTraversalError } from '@/errors/index'

const HYPERDRIVE_KEY = 'a'.repeat(64)
const cacheDir = path.join(os.cwd(), 'test', 'tmp-hyperdrive-cache-path')

// The rejection happens before any corestore or swarm setup, so no drive is needed.
test('hyperdrive download: rejects drive paths that escape the model cache', async function (t) {
  if (!isConfigSet()) setConfig({ cacheDirectory: cacheDir, loggerConsoleOutput: false })
  fs.mkdirSync(cacheDir, { recursive: true })

  const escapes = [
    '../../../etc/qvac-pwned.gguf',
    'models/../../../../tmp/qvac-pwned.gguf',
    'model\0.gguf'
  ]

  try {
    for (const drivePath of escapes) {
      await t.exception(
        () => downloadModelFromHyperdrive(HYPERDRIVE_KEY, drivePath),
        PathTraversalError as unknown as new () => Error,
        `must reject: ${drivePath}`
      )
    }

    for (const escaped of [
      path.resolve(cacheDir, '../../../etc/qvac-pwned.gguf'),
      path.resolve(cacheDir, '../../../../tmp/qvac-pwned.gguf')
    ]) {
      let exists = false
      try {
        fs.accessSync(escaped)
        exists = true
      } catch {}
      t.absent(exists, `nothing written outside the cache: ${escaped}`)
    }
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true })
  }
})
