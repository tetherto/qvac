import test from 'brittle'
import { createTranscribeStreamSession, processLine } from '@/client/api/transcribe'
import { TranscriptionFailedError } from '@/utils/errors-client'

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
