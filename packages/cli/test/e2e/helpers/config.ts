import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'

// A config with a single non-preloaded model. Enough to exercise every
// validation path (routing, schema, auth, CORS, 404/400) without loading
// anything — mirrors the `fake-transcribe` entry the bats cli suite uses.
export const MODELLESS_CONFIG = {
  serve: {
    models: {
      'fake-transcribe': {
        type: 'whispercpp-transcription',
        src: 'hyper://example.invalid/model',
        preload: false
      }
    }
  }
} as const

// Write a qvac.config.json into a throwaway dir and return its path as a
// projectRoot. Cleanup is registered on the test context.
export async function writeConfigDir (t: TestContext, config: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qvac-cli-e2e-'))
  await writeFile(join(dir, 'qvac.config.json'), JSON.stringify(config))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  return dir
}
