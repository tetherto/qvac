import test from 'brittle'
import type { AbortableRPCOptions, LoggingStreamResponse } from '@qvac/inference/surface'
import {
  hasActiveStreamForModel,
  startLoggingStreamForModel,
  stopLoggingStreamForModel
} from '@/client/logging-stream-registry'
import { bindSession, createSessionRecord, sessionOf } from '@/client/session-registry'
import type { Logger } from '@/logging'

// A model logger passed to a session's loadModel streams as that session, so
// the worker ends the stream with the session, and each caller sharing the
// model keeps its own stream.

const silent = { error() {}, warn() {}, info() {}, debug() {} } as unknown as Logger

function recordingOpener() {
  const opened: AbortableRPCOptions[] = []
  const open = (_params: { id: string }, options?: AbortableRPCOptions) => {
    opened.push(options ?? {})
    return (async function* (): AsyncGenerator<LoggingStreamResponse> {
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener('abort', () => resolve())
      )
    })()
  }
  return { opened, open }
}

test('model logger stream: a session load opens the stream as that session', (t) => {
  const { opened, open } = recordingOpener()
  const record = createSessionRecord('s-log', Promise.resolve())
  const sessionOptions = { sessionId: 's-log', timeout: 5000 }
  bindSession(sessionOptions, record)

  startLoggingStreamForModel('m-1', silent, sessionOptions, open as never)

  t.is(opened.length, 1)
  t.is(opened[0]!.sessionId, 's-log', 'the stream carries the session id')
  t.is(sessionOf(opened[0]), record, 'and the session behind it')
  t.is(opened[0]!.timeout, undefined, "the load's timeout does not apply to the stream")
  stopLoggingStreamForModel('m-1', sessionOptions)
})

test('model logger stream: callers sharing a model keep separate streams', (t) => {
  const { opened, open } = recordingOpener()
  const a = { sessionId: 'A' }
  const b = { sessionId: 'B' }

  startLoggingStreamForModel('m-2', silent, a, open as never)
  startLoggingStreamForModel('m-2', silent, b, open as never)
  startLoggingStreamForModel('m-2', silent, undefined, open as never)
  t.is(opened.length, 3, 'one stream per caller')

  stopLoggingStreamForModel('m-2', a)
  t.is(opened[0]!.signal?.aborted, true, "A's stream stops")
  t.is(opened[1]!.signal?.aborted, false, "B's stream keeps running")
  t.is(opened[2]!.signal?.aborted, false, "the owner's stream keeps running")
  t.is(hasActiveStreamForModel('m-2', b), true)

  stopLoggingStreamForModel('m-2', b)
  stopLoggingStreamForModel('m-2')
  t.is(hasActiveStreamForModel('m-2'), false)
})
