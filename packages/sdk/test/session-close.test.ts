import test from 'brittle'
import type { Request, Response } from '@qvac/inference/surface'
import { closeSessionRecord } from '@/client/session'
import {
  createSessionRecord,
  hasClientSessions,
  resetSessionRegistry
} from '@/client/session-registry'
import { SessionInvalidatedError } from '@/utils/errors-client'

// The worker stops accepting a session as soon as its close arrives. A close
// whose reply the client never sees must still end the client's record, or
// every retry fails and the owner never auto-closes.

test('session close: a close whose reply is lost still ends the session', async (t) => {
  resetSessionRegistry()
  const record = createSessionRecord('s-timeout', Promise.resolve())
  const timedOut = async (_request: Request): Promise<Response> => {
    throw new Error('RPC timeout')
  }

  await t.exception(closeSessionRecord(record, undefined, timedOut as never), /RPC timeout/)
  t.is(hasClientSessions(), false, 'the session no longer keeps the runtime up')
  await t.exception(
    closeSessionRecord(record, undefined, timedOut as never),
    SessionInvalidatedError as unknown as new () => Error,
    'a retry is refused locally instead of reaching the worker'
  )
  resetSessionRegistry()
})
