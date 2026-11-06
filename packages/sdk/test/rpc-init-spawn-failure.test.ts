import test from 'brittle'
import { getRPC, close } from '@/client/rpc/node-rpc-client'
import { BareRuntimeBinaryNotFoundError } from '@/utils/errors-client'

const FAKE_PLATFORM = 'commodore64'

function defineProcessValue(name: 'platform', value: string) {
  Object.defineProperty(process, name, {
    configurable: true,
    value
  })
}

function restoreProcessProperty(name: 'platform', descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(process, name, descriptor)
}

void test('RPC init maps bare-runtime binary resolution failures', async function (t) {
  t.timeout(10_000)

  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  const originalArch = process.arch

  t.teardown(async function () {
    restoreProcessProperty('platform', platformDescriptor)
    try {
      await close()
    } catch {}
  })

  defineProcessValue('platform', FAKE_PLATFORM)

  let thrown: Error | undefined
  try {
    await getRPC()
  } catch (error) {
    thrown = error as Error
  }

  t.ok(
    thrown instanceof BareRuntimeBinaryNotFoundError,
    `expected BareRuntimeBinaryNotFoundError, got ${thrown?.name}`
  )
  t.is(thrown?.name, 'BARE_RUNTIME_BINARY_NOT_FOUND')
  t.ok(
    thrown?.message.includes(`bare-runtime-${FAKE_PLATFORM}-${originalArch}`),
    `expected target package in error message, got: ${thrown?.message}`
  )
})

void test('RPC client retries the connection after a failed init', async function (t) {
  t.timeout(10_000)

  const { send, close: closeClient } = await import('@/client/rpc/rpc-client')
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

  t.teardown(async function () {
    restoreProcessProperty('platform', platformDescriptor)
    try {
      await closeClient()
    } catch {}
  })

  defineProcessValue('platform', FAKE_PLATFORM)

  async function failure(call: Promise<unknown>) {
    try {
      await call
    } catch (error) {
      return error as Error
    }
    return undefined
  }

  // Both calls start before the first attempt settles, so they share it.
  const [first, concurrent] = await Promise.all([
    failure(send({ type: 'heartbeat' })),
    failure(send({ type: 'heartbeat' }))
  ])
  // `#rpc` resolves to the built client, so match by name rather than class.
  t.is(first?.name, 'BARE_RUNTIME_BINARY_NOT_FOUND', 'the first call fails')
  t.is(concurrent, first, 'a concurrent caller shares the same failed attempt')

  const later = await failure(send({ type: 'heartbeat' }))
  t.is(later?.name, 'BARE_RUNTIME_BINARY_NOT_FOUND', 'the later call fails the same way')
  t.not(later, first, 'a later call starts a fresh connection attempt')
})
