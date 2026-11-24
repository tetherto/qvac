import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

const closeRPC = mock.fn(async () => {})

mock.module('#rpc', {
  exports: {
    getRPC: mock.fn(),
    close: closeRPC,
    createDuplexSession: mock.fn(),
    getWorkerLifeSignal: () => null,
    notifyChannelClosed: mock.fn(),
    mountBrowserFile: mock.fn(),
    mountBrowserFiles: mock.fn()
  }
})

const { close } = await import('@/client/rpc/rpc-client')

test('public close preserves the no-op behavior when no runtime exists', async () => {
  await close()
  assert.equal(closeRPC.mock.callCount(), 0)
})
