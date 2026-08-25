import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import {
  decodeAudioToStream,
  decoderResponseToStream,
  type DecoderResponseLike
} from '@/utils/audio/decoder'

/**
 * Fake decoder response that emits `chunks` PCM buffers, waiting `gapMs`
 * between them, then finishes. `stallAfter` makes it go silent forever after
 * that many chunks (never finishing) to simulate a hung decoder.
 */
function fakeResponse(chunks: number, gapMs: number, stallAfter = Infinity) {
  let onUpdate: ((output: { outputArray: ArrayBuffer }) => void) | undefined
  let onFinish: (() => void) | undefined
  let resolveAwait: () => void = () => {}
  const awaited = new Promise<void>((resolve) => {
    resolveAwait = resolve
  })
  const response: DecoderResponseLike = {
    onUpdate(callback) {
      onUpdate = callback
      return response
    },
    onFinish(callback) {
      onFinish = callback
      return response
    },
    onError() {
      return response
    },
    await() {
      return awaited
    }
  }
  void (async () => {
    for (let index = 0; index < chunks; index++) {
      if (index >= stallAfter) return
      await new Promise<void>((resolve) => setTimeout(resolve, gapMs))
      onUpdate?.({ outputArray: new Float32Array([index]).buffer })
    }
    onFinish?.()
    resolveAwait()
  })()
  return response
}

async function drain(stream: AsyncIterable<Uint8Array>) {
  const collected: Uint8Array[] = []
  for await (const chunk of stream) collected.push(chunk)
  return collected
}

test('decoder stream timeout is inactivity-based, not a cap on total decode time', async (t) => {
  let settled = 0
  const stream = decoderResponseToStream(fakeResponse(12, 30), {
    inputPath: 'long.wav',
    inactivityTimeoutMs: 120,
    onSettled: () => settled++
  })
  const started = Date.now()
  const chunks = await drain(stream as unknown as AsyncIterable<Uint8Array>)
  const elapsed = Date.now() - started

  t.is(chunks.length, 12, 'every chunk was delivered')
  t.ok(elapsed > 120, `total decode (${elapsed}ms) outlived the inactivity window`)
  t.is(settled, 1, 'the decoder is released exactly once')
})

test('decoder stream fails once the decoder goes silent for the inactivity window', async (t) => {
  let settled = 0
  const stream = decoderResponseToStream(fakeResponse(10, 10, 2), {
    inputPath: 'hung.wav',
    inactivityTimeoutMs: 80,
    onSettled: () => settled++
  })
  try {
    await drain(stream as unknown as AsyncIterable<Uint8Array>)
    t.fail('expected the stream to fail')
  } catch (error) {
    t.ok(/produced no output for 80ms/.test((error as Error).message))
    t.ok(/hung\.wav/.test((error as Error).message))
  }
  t.is(settled, 1, 'the decoder is released after the timeout')
})

test('destroying the decoder stream early releases the decoder', async (t) => {
  let settled = 0
  const stream = decoderResponseToStream(fakeResponse(50, 10), {
    inputPath: 'abandoned.wav',
    inactivityTimeoutMs: 1000,
    onSettled: () => settled++
  })
  const iterator = (stream as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
  await iterator.next()
  ;(stream as unknown as { destroy(): void }).destroy()
  await new Promise<void>((resolve) => setTimeout(resolve, 50))
  t.is(settled, 1, 'close settles the bridge and releases the decoder once')
})

test('a long WAV decodes fully with an inactivity window far below its total decode time', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-decoder-timeout-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))

  // Five minutes of audio: many times longer than the inactivity window, and
  // well past what the previous fixed 10 s total timeout was sized for on
  // slow devices.
  const inputRate = 44100
  const seconds = 300
  const frames = new Int16Array(inputRate * seconds)
  for (let index = 0; index < frames.length; index++) {
    frames[index] = Math.round(Math.sin(index / 20) * 12000)
  }
  const wavPath = path.join(dir, 'long.wav')
  writeWav(wavPath, inputRate, 1, frames)

  const stream = await decodeAudioToStream(wavPath, 'f32le', {
    sampleRate: 48000,
    inactivityTimeoutMs: 100
  })
  const chunks = await drain(stream as unknown as AsyncIterable<Uint8Array>)
  const bytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const decodedFrames = bytes / Float32Array.BYTES_PER_ELEMENT
  t.ok(
    Math.abs(decodedFrames - 48000 * seconds) < 48000,
    `decoded ${decodedFrames} frames for ${48000 * seconds} expected`
  )
})

function writeWav(filePath: string, sampleRate: number, channels: number, frames: Int16Array) {
  const dataBytes = frames.length * Int16Array.BYTES_PER_ELEMENT
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * 2, 28)
  header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)
  fs.writeFileSync(
    filePath,
    Buffer.concat([header, Buffer.from(frames.buffer, frames.byteOffset, frames.byteLength)])
  )
}
