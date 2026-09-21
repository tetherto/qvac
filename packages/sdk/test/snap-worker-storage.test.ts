import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'brittle'
import { heartbeat } from '@/client/api/heartbeat'
import { close } from '@/client/rpc/rpc-client'

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = value
}

void test('worker storage remains in Snap common across revision homes', async function (t) {
  t.timeout(30_000)

  const root = mkdtempSync(join(tmpdir(), 'qvac-snap-storage-'))
  const commonDir = join(root, 'common')
  const firstRevisionHome = join(root, 'revision-1')
  const secondRevisionHome = join(root, 'revision-2')
  const commonLock = join(commonDir, '.qvac', '.worker.lock')
  const originalSnapCommon = process.env['SNAP_USER_COMMON']
  const originalHome = process.env['HOME']
  const originalWorkerPath = process.env['QVAC_WORKER_PATH']

  t.teardown(async function () {
    try {
      await close()
    } catch {}
    restoreEnv('SNAP_USER_COMMON', originalSnapCommon)
    restoreEnv('HOME', originalHome)
    restoreEnv('QVAC_WORKER_PATH', originalWorkerPath)
    rmSync(root, { recursive: true, force: true })
  })

  process.env['SNAP_USER_COMMON'] = commonDir
  process.env['HOME'] = firstRevisionHome
  delete process.env['QVAC_WORKER_PATH']

  await heartbeat()
  t.ok(existsSync(commonLock), 'first worker lock is stored in Snap common')
  t.absent(existsSync(join(firstRevisionHome, '.qvac')), 'first revision home remains unused')

  await close()
  process.env['HOME'] = secondRevisionHome

  await heartbeat()
  t.ok(existsSync(commonLock), 'replacement worker reuses Snap common')
  t.absent(existsSync(join(secondRevisionHome, '.qvac')), 'second revision home remains unused')
})
