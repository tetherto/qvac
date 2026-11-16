import test from 'brittle'
import type { Request, Response } from '@qvac/inference/surface'
import { createUnloadModelCall } from '@/client/api/unload-model'
import { createSessionRecord, endSession, resetSessionRegistry } from '@/client/session-registry'

// The worker reports no open session when it builds the unload reply, but a
// session this client started opening while the reply was in flight must
// still keep the owner's auto-close from stopping the runtime.

function unloadReply(onSend: () => void) {
  return async (_request: Request): Promise<Response> => {
    onSend()
    return {
      type: 'unloadModel',
      success: true,
      hasActiveModels: false,
      hasOpenSessions: false,
      released: true,
      unloaded: true
    } as Response
  }
}

test('owner unload: a session opening during the unload keeps the runtime up', async (t) => {
  resetSessionRegistry()
  let closes = 0
  const closeRuntime = async () => {
    closes++
  }
  let opening: ReturnType<typeof createSessionRecord> | undefined
  const send = unloadReply(() => {
    opening = createSessionRecord('opening', new Promise<void>(() => {}))
  })

  await createUnloadModelCall(
    { modelId: 'm', autoClose: true },
    undefined,
    send as never,
    closeRuntime
  )
  t.is(closes, 0, 'the pending session blocks the auto-close')

  endSession(opening!, 'closed')
  await createUnloadModelCall(
    { modelId: 'm', autoClose: true },
    undefined,
    unloadReply(() => {}) as never,
    closeRuntime
  )
  t.is(closes, 1, 'once the session ended the owner auto-closes')
})

test('owner unload: a session whose open failed does not keep the runtime up', async (t) => {
  resetSessionRegistry()
  let closes = 0
  createSessionRecord('failed', Promise.reject(new Error('open failed')))
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

  await createUnloadModelCall(
    { modelId: 'm', autoClose: true },
    undefined,
    unloadReply(() => {}) as never,
    async () => {
      closes++
    }
  )
  t.is(closes, 1)
  resetSessionRegistry()
})
