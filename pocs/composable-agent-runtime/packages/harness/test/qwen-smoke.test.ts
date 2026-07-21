import test from 'brittle'
import AbortController from '#abort-controller'
import { access } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import os from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import stow from 'bare-stow'
import { spawnHarness } from '../index.ts'

test('real SDK streams from pre-provisioned Qwen without downloading', async (t) => {
  t.timeout(120_000)
  if (process.env.QVAC_REAL_MODEL_SMOKE !== '1') {
    throw new Error('run explicitly with `bun run test:smoke:qwen`')
  }
  const storageRoot = process.env.QVAC_SDK_STORAGE_ROOT ?? join(homedir(), '.qvac')
  const model = join(
    storageRoot,
    'models',
    '3a65a2a3c6a30a47_Qwen3.5-4B-Q4_K_M.gguf'
  )
  await access(model).catch(() => {
    throw new Error(`Qwen smoke requires a pre-provisioned model at ${model}; no download was attempted`)
  })
  const harness = spawnHarness({ entry: await stowQwenSdk() })
  const events = []
  for await (const event of harness.run({
    runId: 'qwen-smoke',
    model,
    messages: [{ role: 'user', content: 'Reply with OK.' }],
    signal: new AbortController().signal
  })) {
    events.push(event)
  }
  t.ok(events.some((event) => event.type === 'content'))
  await harness.close()
})

async function stowQwenSdk() {
  const outputDirectory = new URL('./fixtures/.stow-qwen/', import.meta.url)
  rmSync(fileURLToPath(outputDirectory), { recursive: true, force: true })
  const output = new URL('qwen-sdk.js', outputDirectory)
  const artifacts = stow(
    new URL('../qwen-sdk-entry.ts', import.meta.url).href,
    'bare-sidecar',
    output.href,
    {
      base: new URL('../../../', import.meta.url).href,
      hosts: [`${os.platform()}-${os.arch()}`]
    }
  )
  for await (const _artifact of artifacts);
  return fileURLToPath(new URL('qwen-sdk.bundle', outputDirectory))
}
