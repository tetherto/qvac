import test from 'brittle'
import { reconstructError } from '@/client/rpc/rpc-error'
// Built with @qvac/inference's classes and envelope, as the worker sends them.
import {
  CapabilityNotGrantedError as InferenceCapabilityNotGrantedError,
  SessionGrantInvalidError as InferenceSessionGrantInvalidError,
  createErrorResponse
} from '@qvac/inference/surface'
import { CapabilityNotGrantedError, SessionGrantInvalidError } from '@/utils/errors-server'

test('reconstructError: CapabilityNotGrantedError keeps its operation, session and permission', (t) => {
  const result = reconstructError(
    createErrorResponse(
      new InferenceCapabilityNotGrantedError(
        'transcribeStream',
        's-1',
        'transcription/transcribeStream'
      )
    )
  )
  t.ok(result instanceof CapabilityNotGrantedError)
  const error = result as CapabilityNotGrantedError
  t.is(error.operation, 'transcribeStream')
  t.is(error.sessionId, 's-1')
  t.is(error.required, 'transcription/transcribeStream')
  t.is(error.code, 53625)
})

test('reconstructError: CapabilityNotGrantedError keeps a null permission', (t) => {
  const result = reconstructError(
    createErrorResponse(new InferenceCapabilityNotGrantedError('debugDump', 's-1', null))
  )
  t.ok(result instanceof CapabilityNotGrantedError)
  t.is((result as CapabilityNotGrantedError).required, null)
})

test('reconstructError: SessionGrantInvalidError keeps its permission and reason', (t) => {
  const result = reconstructError(
    createErrorResponse(
      new InferenceSessionGrantInvalidError(
        's-2',
        'embedding/embed',
        'no registered plugin declares it'
      )
    )
  )
  t.ok(result instanceof SessionGrantInvalidError)
  const error = result as SessionGrantInvalidError
  t.is(error.sessionId, 's-2')
  t.is(error.permission, 'embedding/embed')
  t.is(error.details, 'no registered plugin declares it')
  t.ok(error.message.includes('no registered plugin declares it'))
  t.is(error.code, 53626)
})
