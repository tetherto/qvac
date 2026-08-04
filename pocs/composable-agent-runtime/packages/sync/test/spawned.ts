import fs from 'fs'
import os from 'os'
import path from 'path'
import test from 'brittle'
import stow from 'bare-stow'
import tmp from 'test-tmp'
import { fileURLToPath } from 'url'
import { spawnSync } from '../lib/spawn.ts'
import { durableWorkProfile } from '../profiles/durable-work.ts'

async function stowSource(entry: URL, name: string) {
  const outputDirectory = new URL('../../../.stow-sync/', import.meta.url)
  const output = new URL(`${name}.js`, outputDirectory)
  const artifacts = stow(
    entry.href,
    'bare-sidecar',
    output.href,
    {
      base: new URL('../', import.meta.url).href,
      hosts: [`${os.platform()}-${os.arch()}`]
    }
  )
  for await (const _artifact of artifacts);
  return fileURLToPath(new URL(`${name}.bundle`, output))
}

test('sync: spawned Bare sidecar crosses HRPC and releases persistent storage', async (t) => {
  t.timeout(60_000)
  const dir = await tmp(t)
  const storagePath = path.join(dir, 'storage')
  const outputDirectory = new URL('../../../.stow-sync/', import.meta.url)
  fs.rmSync(fileURLToPath(outputDirectory), { recursive: true, force: true })
  t.teardown(() => fs.rmSync(fileURLToPath(outputDirectory), { recursive: true, force: true }))
  const entry = await stowSource(new URL('../sidecar-entry.ts', import.meta.url), 'sync-sidecar')

  const first = await spawnSync({
    entry,
    storagePath,
    logging: { level: 'info' }
  })
  const identity = await first.getIdentity()
  t.ok(identity.deviceId.byteLength > 0, 'identity crossed the spawned boundary')
  t.ok(
    first.diagnostics.stderr.includes('[sync]') &&
      first.diagnostics.stderr.includes('runtime ready'),
    'top-level logging configuration reached the Sync sidecar'
  )
  const profile = first.openProfile(durableWorkProfile)
  await profile.apply(
    {
      type: 'record-work',
      workId: 'spawned-work',
      payload: Buffer.from('persist this work'),
      payloadFormat: 'text/plain',
      payloadVersion: 1
    },
    { operationId: 'spawned-create' }
  )
  await profile.apply(
    {
      type: 'record-outcome',
      workId: 'spawned-work',
      status: 'completed',
      result: Buffer.from('done')
    },
    { operationId: 'spawned-outcome' }
  )

  await first.close()
  t.alike(await first.exited, { code: 0, signal: null })

  const second = await spawnSync({ entry, storagePath })
  t.alike(await second.getIdentity(), identity)
  const persisted = await second
    .openProfile(durableWorkProfile)
    .query({ type: 'get-work', workId: 'spawned-work' })
  t.is(persisted.work?.outcomeStatus, 'completed')
  t.alike(persisted.work?.outcomeResult, Buffer.from('done'))
  await second.close()
  t.alike(await second.exited, { code: 0, signal: null })

  const forcedStorage = path.join(dir, 'forced-storage')
  const forced = await spawnSync({ entry, storagePath: forcedStorage })
  await forced.getIdentity()
  const forcedExit = await forced.forceTerminate()
  t.ok(
    forcedExit.code !== null || forcedExit.signal !== null,
    'forced Sync child reported its exit'
  )
  fs.rmSync(forcedStorage, { recursive: true, force: true })
  t.absent(
    fs.existsSync(forcedStorage),
    'forced Sync child released its storage lock without killing the host'
  )

  fs.rmSync(storagePath, { recursive: true, force: true })
  t.absent(fs.existsSync(storagePath), 'spawned sidecar released the storage lock')
})

test('sync: spawned Bare startup failure preserves diagnostics off the public message', async (t) => {
  t.timeout(30_000)
  const dir = await tmp(t)
  const outputDirectory = new URL('../../../.stow-sync/', import.meta.url)
  fs.rmSync(fileURLToPath(outputDirectory), { recursive: true, force: true })
  t.teardown(() => fs.rmSync(fileURLToPath(outputDirectory), { recursive: true, force: true }))
  const entry = await stowSource(
    new URL('./fixtures/failing-sidecar.ts', import.meta.url),
    'failing-sidecar'
  )

  try {
    await spawnSync({ entry, storagePath: path.join(dir, 'unused') })
    t.ok(false, 'spawnSync should reject')
  } catch (error) {
    t.is(Reflect.get(error as object, 'name'), 'SYNC_COMPONENT_START_FAILED')
    t.is(Reflect.get(error as object, 'code'), 59001)
    t.absent(
      String(Reflect.get(error as object, 'message')).includes(
        'sync-sidecar-stdout'
      ),
      'public error message omits child diagnostics'
    )
    const diagnostics = Reflect.get(error as object, 'diagnostics')
    t.ok(
      typeof diagnostics === 'object' &&
        diagnostics !== null &&
        String(Reflect.get(diagnostics, 'stdout')).includes(
          'sync-sidecar-stdout'
        ) &&
        String(Reflect.get(diagnostics, 'stderr')).includes(
          'sync-sidecar-stderr'
        ),
      'diagnostics remain available for local debugging'
    )
  }
})
