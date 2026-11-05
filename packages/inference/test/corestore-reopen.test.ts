import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import Corestore from 'corestore'

// bare-fs 4.5.5 to 4.8.3 truncated stat times to 32 bits on Windows, so
// device-file rejected every reopen of an on-disk store with "Invalid device
// file, was modified". The registry, Hyperdrive and RAG stores all reopen this way.
test('corestore: reopens an existing on-disk store', async function (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-corestore-reopen-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))

  const first = new Corestore(dir)
  await first.ready()
  await first.close()

  const second = new Corestore(dir)
  await t.execution(second.ready())
  await second.close()
})
