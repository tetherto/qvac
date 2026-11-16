'use strict'

const test = require('brittle')
const tmp = require('test-tmp')
const fs = require('#fs')
const os = require('#os')
const path = require('#path')
const RegistryConfig = require('../../lib/config')
const { getEnv } = require('../../utils/env')
const { ENV_KEYS } = require('@qvac/registry-schema')

function logger() {
  return {
    info() {},
    debug() {},
    warn() {},
    error() {}
  }
}

// Runs the real constructor and close(); only the swarm half of _open is
// skipped, so the Corestore still opens its storage on disk.
function makeClient(opts = {}) {
  const QVACRegistryClient = require('../../lib/client')
  class OfflineClient extends QVACRegistryClient {
    async _open() {
      await this.corestore.ready()
    }
  }
  return new OfflineClient({ logger: { enabled: false }, ...opts })
}

test('close removes temp storage the client created', async (t) => {
  if (getEnv(ENV_KEYS.REGISTRY_STORAGE)) {
    t.comment('REGISTRY_STORAGE is set; skipping the temp-storage case')
    return
  }

  const client = makeClient()
  await client.ready()
  t.ok(fs.existsSync(client.storage), 'temp storage opened')

  await client.close()

  t.absent(fs.existsSync(client.storage), 'temp storage removed')
})

test('close keeps storage the caller provided', async (t) => {
  const storage = path.join(await tmp(t), 'storage')

  const client = makeClient({ storage })
  await client.ready()
  await client.close()

  t.ok(fs.existsSync(storage), 'provided storage kept')
})

// lunte-disable-next-line require-await
test('config records a temp storage path only when it creates one', async (t) => {
  const provided = new RegistryConfig({ logger: logger() })
  provided.getRegistryStorage('/srv/registry')
  t.is(provided.tempStoragePath, undefined, 'no temp path for provided storage')

  if (getEnv(ENV_KEYS.REGISTRY_STORAGE)) {
    t.comment('REGISTRY_STORAGE is set; skipping the temp-path case')
    return
  }

  const created = new RegistryConfig({ logger: logger() })
  const storage = created.getRegistryStorage()
  t.is(created.tempStoragePath, storage, 'temp path recorded')
  t.is(path.dirname(storage), os.tmpdir(), 'temp path is under os.tmpdir()')
})
