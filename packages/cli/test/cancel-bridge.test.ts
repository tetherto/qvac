import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import type { Logger } from '../src/logger.js'
import { bindClientDisconnectCancel } from '../src/serve/core/cancel-bridge.js'

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
