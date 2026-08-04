import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import stow from 'bare-stow'
import { afterEach, describe, expect, test } from 'vitest'
import { spawnHarness } from '../packages/harness/lib/spawn.ts'
import { spawnSync } from '../packages/sync/lib/spawn.ts'

const temporary: string[] = []
const root = new URL('..', import.meta.url)

afterEach(async function () {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('desktop runtime crash isolation', function () {
  test('forced Harness and Sync exits do not terminate their sibling runtime', async function () {
    const directory = await mkdtemp(join(tmpdir(), 'qvac-runtime-isolation-'))
    const bundleDirectory = join(
      fileURLToPath(root),
      `.stow-crash-${process.pid}-${Date.now()}`
    )
    await mkdir(bundleDirectory, { recursive: true })
    temporary.push(directory)
    temporary.push(bundleDirectory)
    const syncEntry = await stowEntry(
      new URL('packages/sync/sidecar-entry.ts', root),
      join(bundleDirectory, 'sync'),
      new URL('packages/sync/', root)
    )
    const harnessEntry = await stowEntry(
      new URL('packages/harness/test/fixtures/fake-harness-sidecar.mjs', root),
      join(bundleDirectory, 'harness'),
      root
    )
    const sync = await spawnSync({
      entry: syncEntry,
      storagePath: join(directory, 'sync-storage')
    })
    const harness = spawnHarness({ entry: harnessEntry })

    expect(await runHarness(harness, 'before-harness-crash')).toEqual([
      { type: 'content', text: 'spawned' }
    ])
    await harness.forceTerminate()
    expect((await sync.getIdentity()).deviceId.byteLength).toBeGreaterThan(0)

    const replacementHarness = spawnHarness({ entry: harnessEntry })
    expect(await runHarness(replacementHarness, 'before-sync-crash')).toEqual([
      { type: 'content', text: 'spawned' }
    ])
    await sync.forceTerminate()
    expect(await runHarness(replacementHarness, 'after-sync-crash')).toEqual([
      { type: 'content', text: 'spawned' }
    ])
    await replacementHarness.close()
  }, 60_000)
})

async function runHarness(
  harness: ReturnType<typeof spawnHarness>,
  runId: string
) {
  const events = []
  for await (const event of harness.run({
    runId,
    model: 'fake',
    messages: [],
    signal: new AbortController().signal
  })) {
    events.push(event)
  }
  return events
}

async function stowEntry(entry: URL, outputBase: string, base: URL) {
  const output = pathToFileURL(`${outputBase}.js`)
  const artifacts = stow(entry.href, 'bare-sidecar', output.href, {
    base: base.href,
    hosts: [`${process.platform}-${process.arch}`]
  })
  for await (const _artifact of artifacts);
  return fileURLToPath(pathToFileURL(`${outputBase}.bundle`))
}
