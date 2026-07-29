'use strict'

// Verifies the ACE-Step GGUFs are published in the QVAC model registry, queried
// over hyperdrive with the same client the SDK uses. This intentionally only
// checks existence + metadata via getModel() — it does NOT download the
// multi-GB blobs. Requires registry/network connectivity.

const test = require('brittle')
const { QVACRegistryClient } = require('@qvac/registry-client')
const { REGISTRY_SOURCE, allRegistryPaths } = require('../../models.js')

test('ACE-Step models exist in the registry (existence only, no download)', async (t) => {
  t.timeout(180000)

  const client = new QVACRegistryClient()
  t.teardown(() => client.close())
  await client.ready()

  for (const path of allRegistryPaths()) {
    const entry = await client.getModel(path, REGISTRY_SOURCE)
    t.ok(entry, `exists: ${path}`)
    if (entry) t.is(entry.engine, '@qvac/audiogen', `engine tag: ${path}`)
  }
})
