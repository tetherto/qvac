import test from 'brittle'
import { rmSync } from 'fs'
import os from 'os'
import { fileURLToPath } from 'url'
import stow from 'bare-stow'
import { spawnHarness } from '../lib/spawn.ts'

async function stowFixture() {
  const outputDirectory = new URL('./fixtures/.stow/', import.meta.url)
  rmSync(fileURLToPath(outputDirectory), { recursive: true, force: true })
  const entry = new URL('./fixtures/fake-harness-sidecar.mjs', import.meta.url)
  const artifacts = stow(entry.href, 'bare-sidecar', new URL('harness.js', outputDirectory).href, {
    base: new URL('../../../', import.meta.url).href,
    hosts: [`${os.platform()}-${os.arch()}`]
  })
  for await (const _artifact of artifacts);
  return fileURLToPath(new URL('harness.bundle', outputDirectory))
}

test('spawned Bare harness crosses HRPC and closes cleanly', async (t) => {
  const remote = spawnHarness({ entry: await stowFixture() })
  const events = []
  for await (const event of remote.run({
    runId: 'spawned-run',
    model: 'fake',
    messages: [],
    signal: new AbortController().signal
  })) {
    events.push(event)
  }
  t.alike(events, [{ type: 'content', text: 'spawned' }])
  await remote.close()
})

test('forced Harness child termination leaves the host test alive', async (t) => {
  const remote = spawnHarness({ entry: await stowFixture() })
  for await (const _event of remote.run({
    runId: 'forced-run',
    model: 'fake',
    messages: [],
    signal: new AbortController().signal
  }));

  const exit = await remote.forceTerminate()
  t.ok(exit.code !== null || exit.signal !== null, 'the spawned child reported its exit')
  t.ok(true, 'the host remained alive after child termination')
})
