import test from 'brittle'
import Buffer from 'bare-buffer'
import {
  createTranscribeStreamSession,
  processLine,
  processLineConversation
} from '@/api/transcribe'
import { TranscriptionFailedError } from '@/errors'

interface FakeRequestStream {
  write(chunk: Uint8Array): void
  end(): void
  destroy(): void
}

function createDuplexFactory(lines: string[]) {
  return async function () {
    const requestStream: FakeRequestStream = {
      write() {},
      end() {},
      destroy() {}
    }
    const responseStream = {
      destroy() {},
      async *[Symbol.asyncIterator]() {
        for (const line of lines) {
          yield Buffer.from(`${line}\n`)
        }
      }
    }
    return { requestStream, responseStream }
  }
}

async function collect(stream: AsyncIterable<string>) {
  const values: string[] = []
  for await (const value of stream) {
    values.push(value)
  }
  return values
}

test('transcribe stream session resolves terminal stats without yielding the done frame', async (t) => {
  const session = await createTranscribeStreamSession(
    { modelId: 'model' },
    undefined,
    processLine,
    'TranscribeStreamSession',
    createDuplexFactory([
      JSON.stringify({ type: 'transcribeStream', text: 'hello' }),
      JSON.stringify({
        type: 'transcribeStream',
        done: true,
        stats: {
          audioDuration: 1250,
          realTimeFactor: 0.4,
          encoderTime: 12
        }
      })
    ]) as never
  )

  t.alike(await collect(session), ['hello'])
  t.alike(await session.stats, {
    audioDuration: 1250,
    realTimeFactor: 0.4,
    encoderTime: 12
  })
})

test('transcribe stream session rejects stats when the response stream fails', async (t) => {
  const session = await createTranscribeStreamSession(
    { modelId: 'model' },
    undefined,
    processLine,
    'TranscribeStreamSession',
    createDuplexFactory([
      JSON.stringify({
        type: 'error',
        message: 'stream failed'
      })
    ]) as never
  )

  const outcomes = await Promise.allSettled([collect(session), session.stats])
  for (const outcome of outcomes) {
    t.is(outcome.status, 'rejected')
    if (outcome.status === 'rejected') {
      t.ok(outcome.reason instanceof TranscriptionFailedError)
    }
  }
})

test('transcribe stream session resolves undefined stats after a premature close', async (t) => {
  const session = await createTranscribeStreamSession(
    { modelId: 'model' },
    undefined,
    processLine,
    'TranscribeStreamSession',
    createDuplexFactory([JSON.stringify({ type: 'transcribeStream', text: 'partial' })]) as never
  )

  t.alike(await collect(session), ['partial'])
  t.is(await session.stats, undefined)
})

test('transcribe stream session resolves undefined stats when destroyed', async (t) => {
  const session = await createTranscribeStreamSession(
    { modelId: 'model' },
    undefined,
    processLine,
    'TranscribeStreamSession',
    createDuplexFactory([]) as never
  )

  session.destroy()
  t.is(await session.stats, undefined)
})

// These drive the real session a caller holds, so they prove the values reach
// the public API rather than only surviving a helper in isolation.

test('transcribe stream session resolves diagnostics from the terminal frame', async (t) => {
  const diagnostics = { selectedBackend: 'metal', selectedDevice: 'gpu', graphicsApi: 'metal' }
  const session = await createTranscribeStreamSession(
    { modelId: 'model' },
    undefined,
    processLine,
    'TranscribeStreamSession',
    createDuplexFactory([
      JSON.stringify({ type: 'transcribeStream', text: 'hello' }),
      JSON.stringify({
        type: 'transcribeStream',
        done: true,
        stats: { audioDuration: 1250 },
        diagnostics
      })
    ]) as never
  )

  t.alike(await collect(session), ['hello'])
  t.alike(await session.diagnostics, diagnostics, 'diagnostics reach the session')
  t.alike(await session.stats, { audioDuration: 1250 }, 'stats still resolve alongside')
})

test('transcribe stream session resolves empty diagnostics when the frame has none', async (t) => {
  const session = await createTranscribeStreamSession(
    { modelId: 'model' },
    undefined,
    processLine,
    'TranscribeStreamSession',
    createDuplexFactory([JSON.stringify({ type: 'transcribeStream', done: true })]) as never
  )

  await collect(session)
  t.ok(session.diagnostics instanceof Promise, 'the session exposes a diagnostics promise')
  t.is(await session.diagnostics, undefined, 'an absent verdict resolves, never hangs')
})

test('transcribe stream session rejects diagnostics when the response stream fails', async (t) => {
  const session = await createTranscribeStreamSession(
    { modelId: 'model' },
    undefined,
    processLine,
    'TranscribeStreamSession',
    createDuplexFactory([JSON.stringify({ type: 'error', message: 'boom' })]) as never
  )

  await t.exception(collect(session))
  await t.exception(session.diagnostics, 'diagnostics fail with the stream')
})

test('conversation session forwards the VAD detector source', async (t) => {
  const session = await createTranscribeStreamSession(
    { modelId: 'model' },
    undefined,
    (line, onTerminal) => processLineConversation(line, false, onTerminal),
    'TranscribeStreamConversationSession',
    createDuplexFactory([
      JSON.stringify({
        type: 'transcribeStream',
        vad: { speaking: true, probability: 0.9, source: 'silero' }
      }),
      JSON.stringify({ type: 'transcribeStream', done: true })
    ]) as never
  )

  const events: unknown[] = []
  for await (const event of session) events.push(event)
  t.alike(
    events[0],
    { type: 'vad', speaking: true, probability: 0.9, source: 'silero' },
    'source reaches the event a caller iterates'
  )
})
