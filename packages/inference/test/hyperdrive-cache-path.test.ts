import test from 'brittle'
import fs from 'bare-fs'
import { downloadModelFromHyperdrive } from '@/handlers/load-model/hyperdrive'
import { PathTraversalError } from '@/errors/index'
import { useTestCacheDir } from './fixtures/test-cache'

const HYPERDRIVE_KEY = 'a'.repeat(64)

// The rejection happens before any corestore or swarm setup, so no drive is needed.
test('hyperdrive download: rejects drive paths that escape the model cache', async function (t) {
  const cacheDir = useTestCacheDir()
  fs.mkdirSync(cacheDir, { recursive: true })

  const escapes = [
    '../../../etc/qvac-pwned.gguf',
    'models/../../../../tmp/qvac-pwned.gguf',
    'x/../sharded/' + 'b'.repeat(64) + '/model-00001-of-00002.gguf',
    'x/../0123abcd_Llama-3.2-1B.gguf',
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
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true })
  }
})
