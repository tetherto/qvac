import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
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

function makeReq(): IncomingMessage {
  return new EventEmitter() as unknown as IncomingMessage
}

function makeRes(initial: { writableEnded?: boolean } = {}): ServerResponse {
  return { writableEnded: initial.writableEnded ?? false } as unknown as ServerResponse
}

describe('bindClientDisconnectCancel', () => {
  it('fires cancel with the bound requestId on req close', async () => {
    const req = makeReq()
    const res = makeRes()
    const cancels: { requestId: string }[] = []
    // lunte-disable-next-line require-await
    bindClientDisconnectCancel(req, res, 'rid-1', makeLogger(), async (opts) => {
      cancels.push(opts)
    })

    req.emit('close')
    // cancel is awaited inside the .catch; let the microtask queue drain
    await Promise.resolve()
    await Promise.resolve()

    assert.equal(cancels.length, 1)
    assert.equal(cancels[0]?.requestId, 'rid-1')
  })

  it('skips cancel when the response already finished', async () => {
    const req = makeReq()
    const res = makeRes({ writableEnded: true })
    let called = 0
    // lunte-disable-next-line require-await
    bindClientDisconnectCancel(req, res, 'rid-2', makeLogger(), async () => {
      called++
    })

    req.emit('close')
    await Promise.resolve()

    assert.equal(called, 0, 'natural completion should not log a benign no-op cancel')
  })

  it('swallows cancel rejections without propagating', async () => {
    const req = makeReq()
    const res = makeRes()
    const logger = makeLogger()
    // lunte-disable-next-line require-await
    bindClientDisconnectCancel(req, res, 'rid-3', logger, async () => {
      throw new Error('cancel race lost')
    })

    req.emit('close')
    await Promise.resolve()
    await Promise.resolve()

    assert.equal(logger.debugs.length, 1)
    assert.match(logger.debugs[0]!, /rid-3/)
    assert.match(logger.debugs[0]!, /cancel race lost/)
  })

  it('binds via req.once so a second close event does not fire cancel twice', async () => {
    const req = makeReq()
    const res = makeRes()
    let called = 0
    // lunte-disable-next-line require-await
    bindClientDisconnectCancel(req, res, 'rid-4', makeLogger(), async () => {
      called++
    })

    req.emit('close')
    req.emit('close')
    await Promise.resolve()
    await Promise.resolve()

    assert.equal(called, 1)
  })
})
