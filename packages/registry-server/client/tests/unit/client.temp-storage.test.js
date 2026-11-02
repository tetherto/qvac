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

// Builds a client WITHOUT running the constructor (which would open a real
// Corestore and join a real swarm); _close only touches the stubs below.
function makeClient(storage, tempStorage) {
  const QVACRegistryClient = require('../../lib/client')
  const client = Object.create(QVACRegistryClient.prototype)
  client.logger = logger()
  client._metadataReady = null
  client.db = null
  client.hyperswarm = null
  client.corestore = {
    // lunte-disable-next-line require-await
    async close() {}
  }
  client.storage = storage
  client._tempStorage = tempStorage
  return client
}

async function makeStorage(t) {
  const storage = path.join(await tmp(t), 'storage')
  fs.mkdirSync(path.join(storage, 'db'), { recursive: true })
  fs.writeFileSync(path.join(storage, 'db', '000001.blob'), 'blob')
  return storage
}

test('close removes temp storage the client created', async (t) => {
  const storage = await makeStorage(t)

  await makeClient(storage, storage)._close()

  t.absent(fs.existsSync(storage), 'temp storage removed')
})

test('close keeps storage the caller provided', async (t) => {
  const storage = await makeStorage(t)

  await makeClient(storage, null)._close()

  t.ok(fs.existsSync(path.join(storage, 'db', '000001.blob')), 'provided storage kept')
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
