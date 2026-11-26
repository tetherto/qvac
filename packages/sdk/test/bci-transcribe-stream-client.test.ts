import test from 'brittle'
import { processLine } from '@/client/api/bci-transcribe'
import { RPCError } from '@/client/rpc/rpc-error'
import { TranscriptionFailedError } from '@/utils/errors-client'
import { RequestRejectedByPolicyError } from '@/utils/errors-server'
import { SDK_SERVER_ERROR_CODES } from '@/schemas/sdk-errors-server'

function causeOf(line: string): unknown {
  try {
    processLine(line)
  } catch (err) {
    if (!(err instanceof TranscriptionFailedError)) throw err
    return err.cause
  }
  throw new Error('expected processLine to throw')
}

test('bci stream error frame keeps the worker error code as cause', (t) => {
  const cause = causeOf(
    JSON.stringify({
      type: 'error',
      name: 'STREAM_ALREADY_ACTIVE',
      code: 26014,
      message: 'A streaming transcription is already in progress'
    })
  )
  t.ok(cause instanceof RPCError)
  t.is((cause as RPCError).code, 26014)
})

test('bci stream error frame rebuilds a typed SDK error as cause', (t) => {
  const cause = causeOf(
    JSON.stringify({
      type: 'error',
      name: 'REQUEST_REJECTED_BY_POLICY',
      code: SDK_SERVER_ERROR_CODES.REQUEST_REJECTED_BY_POLICY,
      message: 'rejected',
      typedFields: { kind: 'transcribe', modelId: 'bci', reason: 'queue full' }
    })
  )
  t.ok(cause instanceof RequestRejectedByPolicyError)
})
