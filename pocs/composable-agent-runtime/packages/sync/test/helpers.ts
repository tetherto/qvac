import type { Test } from 'brittle'
import createTestnet from 'hyperdht/testnet.js'
import tmp from 'test-tmp'
import { Duplex } from 'streamx'
import { SyncClient } from '../lib/client.ts'
import { SyncCore, type SyncCoreOptions } from '../lib/core.ts'

export function duplexPair(): [Duplex, Duplex] {
  let left: Duplex
  let right: Duplex
  left = new Duplex({
    write(data: Buffer, cb: (error: Error | null) => void) {
      right.push(data)
      cb(null)
    },
    final(cb: (error: Error | null) => void) {
      right.push(null)
      cb(null)
    },
    destroy(cb: (error: Error | null) => void) {
      right.destroy()
      cb(null)
    }
  })
  right = new Duplex({
    write(data: Buffer, cb: (error: Error | null) => void) {
      left.push(data)
      cb(null)
    },
    final(cb: (error: Error | null) => void) {
      left.push(null)
      cb(null)
    },
    destroy(cb: (error: Error | null) => void) {
      left.destroy()
      cb(null)
    }
  })
  return [left, right]
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
