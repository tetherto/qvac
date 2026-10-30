import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { removeInvalidRegistryStore } from '@/runtime/registry-client'

function fixture(t: ReturnType<typeof test>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-registry-store-'))
  const storage = path.join(dir, 'registry-corestore')
  fs.mkdirSync(path.join(storage, 'db'), { recursive: true })
  fs.writeFileSync(path.join(storage, 'CORESTORE'), 'device file')
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return storage
}

function deviceFileError(message: string) {
  return Object.assign(new Error(message), { code: 'DEVICE_FILE', fatal: true })
}

test('removeInvalidRegistryStore: removes a store that fails the device-file check', async (t) => {
  for (const message of [
    'Invalid device file, was modified',
    'Invalid device file, was moved unsafely',
    'Invalid device file, was made on different platform'
  ]) {
    const storage = fixture(t)
    t.is(await removeInvalidRegistryStore(deviceFileError(message), storage), true, message)
    t.absent(fs.existsSync(storage), message)
  }
})

test('removeInvalidRegistryStore: keeps the store for other errors', async (t) => {
  const storage = fixture(t)
  for (const error of [
    new Error('File descriptor could not be locked'),
    Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' }),
    'DEVICE_FILE',
    null
  ]) {
    t.is(await removeInvalidRegistryStore(error, storage), false)
  }
  t.ok(fs.existsSync(path.join(storage, 'CORESTORE')))
})
