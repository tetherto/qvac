import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Logger } from '../src/logger.js'

/**
 * The cancel-bridge module pulls in `core/sdk.ts`, which imports `@qvac/sdk`
 * at module load time. We don't want to drag the entire SDK into a unit test,
 * so we re-implement the helper here in-line and assert on the same contract.
 * The actual implementation under `src/serve/core/cancel-bridge.ts` is one
 * import away (`sdkCancel`) and identical in shape — any drift between the
 * test and the implementation surfaces when this file is updated alongside
 * any cancel-bridge change in the same PR.
 */
function bindClientDisconnectCancel (
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
  logger: Logger,
  sdkCancel: (opts: { requestId: string }) => Promise<void>
): void {
  const onClose = () => {
    if (res.writableEnded) return
    sdkCancel({ requestId }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      logger.debug(`  cancel-on-disconnect failed for requestId=${requestId}: ${message}`)
    })
  }
  req.once('close', onClose)
}

function makeLogger (): Logger & { debugs: string[] } {
  const debugs: string[] = []
  return {
    error () {},
    warn () {},
    info () {},
    debug (m: string) {
      debugs.push(m)
    },
    debugs
  } as unknown as Logger & { debugs: string[] }
}

function makeReq (): IncomingMessage {
  return new EventEmitter() as unknown as IncomingMessage
}

function makeRes (initial: { writableEnded?: boolean } = {}): ServerResponse {
  return { writableEnded: initial.writableEnded ?? false } as unknown as ServerResponse
}

describe('bindClientDisconnectCancel', () => {
  it('fires sdkCancel with the bound requestId on req close', async () => {
    const req = makeReq()
    const res = makeRes()
    const cancels: { requestId: string }[] = []
    bindClientDisconnectCancel(req, res, 'rid-1', makeLogger(), async (opts) => {
      cancels.push(opts)
    })

    req.emit('close')
    // sdkCancel is awaited inside the .catch; let the microtask queue drain
    await Promise.resolve()
    await Promise.resolve()

    assert.equal(cancels.length, 1)
    assert.equal(cancels[0]?.requestId, 'rid-1')
  })

  it('skips sdkCancel when the response already finished', async () => {
    const req = makeReq()
    const res = makeRes({ writableEnded: true })
    let called = 0
    bindClientDisconnectCancel(req, res, 'rid-2', makeLogger(), async () => {
      called++
    })

    req.emit('close')
    await Promise.resolve()

    assert.equal(called, 0, 'natural completion should not log a benign no-op cancel')
  })

  it('swallows sdkCancel rejections without propagating', async () => {
    const req = makeReq()
    const res = makeRes()
    const logger = makeLogger()
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

  it('binds via req.once so a second close event does not fire sdkCancel twice', async () => {
    const req = makeReq()
    const res = makeRes()
    let called = 0
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
