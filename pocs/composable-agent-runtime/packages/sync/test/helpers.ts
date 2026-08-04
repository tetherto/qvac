import type { Test } from 'brittle'
import createTestnet from 'hyperdht/testnet.js'
import tmp from 'test-tmp'
import type {
  CreateSyncOptions,
  SyncRuntime
} from '../lib/runtime/types.ts'
import { SyncClient } from '../lib/client.ts'
import { SyncCore, type SyncCoreOptions } from '../lib/core.ts'
import { duplexPair } from '../lib/transport/duplex-pair.ts'

export { duplexPair }
export type { SyncRuntime }

export async function openSyncRuntime(t: Test, options: CreateSyncOptions) {
  const { createSync } = await import('../index.ts')
  const sync = createSync(options)
  await sync.ready()
  t.teardown(() => sync.close())
  return sync
}

export async function openPair(t: Test, options: SyncCoreOptions = {}) {
  const [serverStream, clientStream] = duplexPair()
  const core = new SyncCore(options)
  await core.ready()
  core.connect(serverStream)
  const client = new SyncClient(clientStream)
  await client.ready()
  const close = async () => {
    await client.close()
    await core.close()
  }
  t.teardown(close)
  return { client, core, close }
}

export async function testContext(t: Test) {
  const dir = await tmp(t)
  const testnet = await createTestnet(3, { teardown: t.teardown })
  return { dir, testnet }
}

export async function waitFor<T>(
  query: () => T | Promise<T>,
  timeout = 30_000
): Promise<T | null> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await query()
    if (value !== false && value != null) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}
