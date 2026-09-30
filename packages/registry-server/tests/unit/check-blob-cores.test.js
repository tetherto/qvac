'use strict'

const test = require('brittle')
const IdEnc = require('hypercore-id-encoding')

const { createBlobCoreInventory, parseArgs } = require('../../scripts/check-blob-cores')

test('createBlobCoreInventory groups active and deprecated models by core', (t) => {
  const firstCore = Buffer.alloc(32, 1)
  const secondCore = Buffer.alloc(32, 2)

  const inventory = createBlobCoreInventory([
    model('first.bin', firstCore, { blockOffset: 0, blockLength: 2, byteLength: 100 }),
    model('second.bin', firstCore, {
      blockOffset: 2,
      blockLength: 3,
      byteLength: 200,
      deprecated: true
    }),
    model('third.bin', secondCore, { blockOffset: 4, blockLength: 2, byteLength: 300 })
  ])

  t.alike(inventory.summary, {
    coreCount: 2,
    modelCount: 3,
    deprecatedModelCount: 1,
    referencedBytes: 600
  })
  const expectedCores = [
    {
      coreKey: IdEnc.normalize(firstCore),
      modelCount: 2,
      deprecatedModelCount: 1,
      referencedBytes: 300,
      referencedBlockEnd: 5
    },
    {
      coreKey: IdEnc.normalize(secondCore),
      modelCount: 1,
      deprecatedModelCount: 0,
      referencedBytes: 300,
      referencedBlockEnd: 6
    }
  ].sort((a, b) => a.coreKey.localeCompare(b.coreKey))

  t.alike(inventory.cores, expectedCores)
})

test('createBlobCoreInventory accepts encoded and JSON Buffer core keys', (t) => {
  const core = Buffer.alloc(32, 3)
  const inventory = createBlobCoreInventory([
    model('encoded.bin', IdEnc.normalize(core), { byteLength: 10 }),
    model('json-buffer.bin', core.toJSON(), { blockOffset: 1, byteLength: 20 })
  ])

  t.is(inventory.summary.coreCount, 1)
  t.is(inventory.cores[0].coreKey, IdEnc.normalize(core))
  t.is(inventory.cores[0].referencedBytes, 30)
})

test('createBlobCoreInventory reports an empty registry', (t) => {
  t.alike(createBlobCoreInventory([]), {
    summary: {
      coreCount: 0,
      modelCount: 0,
      deprecatedModelCount: 0,
      referencedBytes: 0
    },
    cores: []
  })
})

test('createBlobCoreInventory rejects malformed blob bindings', async (t) => {
  await t.exception.all(
    () => createBlobCoreInventory([{ path: 'missing.bin', source: 's3' }]),
    /has no blobBinding/
  )
  await t.exception.all(
    () => createBlobCoreInventory([model('bad-key.bin', 'not-a-core-key')]),
    /invalid blobBinding.coreKey/
  )
  await t.exception.all(
    () => createBlobCoreInventory([model('bad-offset.bin', Buffer.alloc(32), { blockOffset: -1 })]),
    /invalid blobBinding.blockOffset/
  )
})

test('parseArgs accepts human and JSON inventory options', async (t) => {
  t.alike(parseArgs(['--registry-key', 'abc', '--json']), {
    json: true,
    registryKey: 'abc'
  })
  t.alike(parseArgs(['--registry-key=def', '--help']), {
    json: false,
    registryKey: 'def',
    help: true
  })
  await t.exception.all(() => parseArgs(['--unknown']), /Unknown argument/)
})

function model(name, coreKey, overrides = {}) {
  const { deprecated = false, ...bindingOverrides } = overrides

  return {
    path: `test/${name}`,
    source: 's3',
    deprecated,
    blobBinding: {
      coreKey,
      blockOffset: 0,
      blockLength: 1,
      byteOffset: 0,
      byteLength: 1,
      sha256: 'unused',
      ...bindingOverrides
    }
  }
}
