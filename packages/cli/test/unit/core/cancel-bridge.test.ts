import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import type { Logger } from '@/logger'
import { bindClientDisconnectCancel } from '@/serve/core/cancel-bridge'

function makeLogger(): Logger & { debugs: string[] } {
  const debugs: string[] = []
  return {
    error() {},
    warn() {},
    info() {},
    debug(m: string) {
      debugs.push(m)
    },
    debugs
  } as unknown as Logger & { debugs: string[] }
}

function makeRes(initial: { writableEnded?: boolean } = {}): ServerResponse {
  const res = new EventEmitter() as unknown as ServerResponse
  Object.assign(res, { writableEnded: initial.writableEnded ?? false })
  return res
}

describe('bindClientDisconnectCancel', () => {
  it('fires cancel with the bound requestId on response close', async () => {
    const res = makeRes()
    const cancels: { requestId: string }[] = []
    // lunte-disable-next-line require-await
    bindClientDisconnectCancel(res, 'rid-1', makeLogger(), async (opts) => {
      cancels.push(opts)
    })

    res.emit('close')
    // cancel is awaited inside the .catch; let the microtask queue drain
    await Promise.resolve()
    await Promise.resolve()

    assert.equal(cancels.length, 1)
    assert.equal(cancels[0]?.requestId, 'rid-1')
  })

  it('skips cancel when the response already finished', async () => {
    const res = makeRes({ writableEnded: true })
    let called = 0
    // lunte-disable-next-line require-await
    bindClientDisconnectCancel(res, 'rid-2', makeLogger(), async () => {
      called++
    })

    res.emit('close')
    await Promise.resolve()

    assert.equal(called, 0, 'natural completion should not log a benign no-op cancel')
  })

  it('swallows cancel rejections without propagating', async () => {
    const res = makeRes()
    const logger = makeLogger()
    // lunte-disable-next-line require-await
    bindClientDisconnectCancel(res, 'rid-3', logger, async () => {
      throw new Error('cancel race lost')
    })

    res.emit('close')
    await Promise.resolve()
    await Promise.resolve()

    assert.equal(logger.debugs.length, 1)
    assert.match(logger.debugs[0]!, /rid-3/)
    assert.match(logger.debugs[0]!, /cancel race lost/)
  })

  it('cancels every id bound to one response from a single listener', async () => {
    const res = makeRes()
    const cancelled: string[] = []
    // lunte-disable-next-line require-await
    const cancelFn = async (opts: { requestId: string }) => {
      cancelled.push(opts.requestId)
    }
    const logger = makeLogger()
    for (const id of ['rid-a', 'rid-b', 'rid-c']) {
      bindClientDisconnectCancel(res, id, logger, cancelFn)
    }

    assert.equal(res.listenerCount('close'), 1, 'one listener regardless of bound id count')

    res.emit('close')
    await Promise.resolve()
    await Promise.resolve()

    assert.deepEqual(cancelled, ['rid-a', 'rid-b', 'rid-c'])
  })

  it('cancels an id bound after close, which the close listener cannot reach', async () => {
    const res = makeRes()
    const cancelled: string[] = []
    // lunte-disable-next-line require-await
    const cancelFn = async (opts: { requestId: string }) => {
      cancelled.push(opts.requestId)
    }
    const logger = makeLogger()

    bindClientDisconnectCancel(res, 'rid-early', logger, cancelFn)
    res.emit('close')
    await Promise.resolve()
    await Promise.resolve()

    bindClientDisconnectCancel(res, 'rid-late', logger, cancelFn)
    await Promise.resolve()
    await Promise.resolve()

    assert.deepEqual(cancelled, ['rid-early', 'rid-late'])
  })

  it('binds via res.once so a second close event does not fire cancel twice', async () => {
    const res = makeRes()
    let called = 0
    // lunte-disable-next-line require-await
    bindClientDisconnectCancel(res, 'rid-4', makeLogger(), async () => {
      called++
    })

    res.emit('close')
    res.emit('close')
    await Promise.resolve()
    await Promise.resolve()

    assert.equal(called, 1)
  })
})
