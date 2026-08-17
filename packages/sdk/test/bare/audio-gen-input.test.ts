import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { AudioGen } from '@qvac/audiogen-ggml'
import type { AudiogenOutputChunk, AudiogenStats, GenerateOptions } from '@qvac/audiogen-ggml'
import { AUDIOGEN_INPUT_CHANNELS, AUDIOGEN_INPUT_SAMPLE_RATE } from '@/schemas/audio-gen'
import { resolveAudioGenPcm } from '@/server/bare/plugins/audiogen-ggml/ops/audio-gen-input'
import { audioGenStream } from '@/server/bare/plugins/audiogen-ggml/ops/audio-gen-stream'
import {
  registerModel,
  unregisterModel,
  type AnyModel
} from '@/server/bare/registry/model-registry'
import { getRequestRegistry } from '@/server/bare/runtime'
import { ModelType } from '@/schemas'
import { AudioFileNotFoundError, InvalidAudioInputError } from '@/utils/errors-server'

type AudioGenResponse = Awaited<ReturnType<AudioGen['run']>>

function createResponse(chunks: AudiogenOutputChunk[], stats: AudiogenStats): AudioGenResponse {
  return {
    async *iterate() {
      for (const chunk of chunks) yield chunk
    },
    async await() {
      return stats
    }
  } as unknown as AudioGenResponse
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audio-gen-input-test-'))
}

function stereoFloat32Bytes(samples: number[]) {
  const pcm = new Float32Array(samples)
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
}

/** Minimal PCM16 WAV writer, so the FFmpeg decode path runs on a real file. */
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
  const body = Buffer.from(frames.buffer, frames.byteOffset, frames.byteLength)
  fs.writeFileSync(filePath, Buffer.concat([header, body]))
}

test('resolveAudioGenPcm accepts raw stereo Float32 bytes as base64', async (t) => {
  const bytes = stereoFloat32Bytes([0.25, -0.25, 0.5, -0.5])
  const pcm = await resolveAudioGenPcm(
    { type: 'base64', value: bytes.toString('base64') },
    'referenceAudio'
  )
  t.ok(pcm instanceof Float32Array)
  t.alike(Array.from(pcm), [0.25, -0.25, 0.5, -0.5])
})

test('resolveAudioGenPcm rejects bytes that are not whole stereo Float32 frames', async (t) => {
  const bytes = stereoFloat32Bytes([0.25, -0.25, 0.5])
  const oddError = await rejection(
    resolveAudioGenPcm({ type: 'base64', value: bytes.toString('base64') }, 'sourceAudio')
  )
  t.ok(oddError instanceof InvalidAudioInputError, 'odd sample count is rejected as non-stereo')
  t.ok(/sourceAudio/.test((oddError as Error).message), 'error names the offending input')
  const emptyError = await rejection(
    resolveAudioGenPcm({ type: 'base64', value: '' }, 'sourceAudio')
  )
  t.ok(emptyError instanceof InvalidAudioInputError, 'empty payload is rejected')
})

test('resolveAudioGenPcm reads raw PCM files and reports missing files', async (t) => {
  const dir = createTempDir()
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))

  const rawPath = path.join(dir, 'reference.f32le')
  fs.writeFileSync(rawPath, stereoFloat32Bytes([0.1, 0.2, 0.3, 0.4]))
  const pcm = await resolveAudioGenPcm({ type: 'filePath', value: rawPath }, 'referenceAudio')
  t.alike(
    Array.from(pcm).map((sample) => Number(sample.toFixed(6))),
    [0.1, 0.2, 0.3, 0.4]
  )

  const missingError = await rejection(
    resolveAudioGenPcm({ type: 'filePath', value: path.join(dir, 'missing.wav') }, 'referenceAudio')
  )
  t.ok(
    missingError instanceof AudioFileNotFoundError,
    'missing file surfaces as AudioFileNotFoundError'
  )
})

test('resolveAudioGenPcm decodes WAV files to 48 kHz stereo Float32 PCM', async (t) => {
  const dir = createTempDir()
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))

  // 0.5 s of a 440 Hz tone at 44.1 kHz mono: exercises both resampling and the
  // mono -> interleaved-stereo duplication.
  const inputRate = 44100
  const seconds = 0.5
  const frames = new Int16Array(Math.round(inputRate * seconds))
  for (let index = 0; index < frames.length; index++) {
    frames[index] = Math.round(Math.sin((2 * Math.PI * 440 * index) / inputRate) * 16000)
  }
  const wavPath = path.join(dir, 'reference.wav')
  writeWav(wavPath, inputRate, 1, frames)

  const pcm = await resolveAudioGenPcm({ type: 'filePath', value: wavPath }, 'referenceAudio')
  const expectedFrames = AUDIOGEN_INPUT_SAMPLE_RATE * seconds
  const decodedFrames = pcm.length / AUDIOGEN_INPUT_CHANNELS
  t.ok(pcm.length % AUDIOGEN_INPUT_CHANNELS === 0, 'interleaved stereo layout')
  t.ok(
    Math.abs(decodedFrames - expectedFrames) < AUDIOGEN_INPUT_SAMPLE_RATE * 0.05,
    `resampled to 48 kHz (${decodedFrames} frames for ${expectedFrames} expected)`
  )
  let peak = 0
  let stereoMismatch = false
  for (let frame = 0; frame < decodedFrames; frame++) {
    const left = pcm[frame * 2]!
    const right = pcm[frame * 2 + 1]!
    if (left !== right) stereoMismatch = true
    peak = Math.max(peak, Math.abs(left))
  }
  t.is(stereoMismatch, false, 'mono source is duplicated onto both channels')
  t.ok(peak > 0.3 && peak <= 1, `normalized float samples (peak ${peak.toFixed(3)})`)
  t.ok(
    Array.from(pcm).every((sample) => Number.isFinite(sample)),
    'all samples are finite'
  )
})

test('audioGen plugin operation forwards 0.2.1 controls and decoded audio to the addon', async (t) => {
  const modelId = 'audio-gen-operation-cover-controls'
  const requestId = 'audio-gen-request-cover-controls'
  let capturedCaption: string | undefined
  let capturedOptions: GenerateOptions | undefined
  const model = new AudioGen({
    files: {
      textEncModel: 'text-encoder.gguf',
      lmModel: 'lm.gguf',
      ditModel: 'dit.gguf',
      vaeModel: 'vae.gguf'
    }
  })
  model.run = async function (caption: string, opts?: GenerateOptions) {
    capturedCaption = caption
    capturedOptions = opts
    return createResponse(
      [{ outputArray: new Int16Array([1, -1]), sampleRate: 48000, channels: 2 }],
      { audioDurationMs: 10 }
    )
  }
  registerModel(modelId, {
    model: model as unknown as AnyModel,
    path: '',
    config: {},
    modelType: ModelType.audiogenGgml
  })
  t.teardown(() => {
    unregisterModel(modelId)
  })

  const sourceBytes = stereoFloat32Bytes([0.5, -0.5, 0.25, -0.25])
  const referenceBytes = stereoFloat32Bytes([0.125, -0.125])
  const frames = []
  for await (const frame of audioGenStream({
    type: 'audioGenStream',
    requestId,
    modelId,
    caption: 'orchestral arrangement with dramatic strings',
    lyrics: '[Instrumental]',
    taskType: 'cover-nofsq',
    sourceAudio: { type: 'base64', value: sourceBytes.toString('base64') },
    referenceAudio: { type: 'base64', value: referenceBytes.toString('base64') },
    audioCoverStrength: 1,
    coverNoiseStrength: 0.75,
    lmTemperature: 0.7,
    lmTopP: 0.8,
    lmTopK: 40,
    lmCfgScale: 2.5,
    lmPhase1: false,
    dcwEnabled: false,
    dcwScaler: 0.04,
    dcwHighScaler: 0.01
  })) {
    frames.push(frame)
  }

  t.is(capturedCaption, 'orchestral arrangement with dramatic strings')
  t.is(capturedOptions?.lyrics, '[Instrumental]')
  t.is(capturedOptions?.taskType, 'cover-nofsq')
  t.is(capturedOptions?.audioCoverStrength, 1)
  t.is(capturedOptions?.coverNoiseStrength, 0.75)
  t.is(capturedOptions?.lmTemperature, 0.7)
  t.is(capturedOptions?.lmTopP, 0.8)
  t.is(capturedOptions?.lmTopK, 40)
  t.is(capturedOptions?.lmCfgScale, 2.5)
  t.is(capturedOptions?.lmPhase1, false)
  t.is(capturedOptions?.dcwEnabled, false)
  t.is(capturedOptions?.dcwScaler, 0.04)
  t.is(capturedOptions?.dcwHighScaler, 0.01)
  t.ok(capturedOptions?.sourceAudio instanceof Float32Array)
  t.alike(Array.from(capturedOptions?.sourceAudio ?? []), [0.5, -0.5, 0.25, -0.25])
  t.ok(capturedOptions?.referenceAudio instanceof Float32Array)
  t.alike(Array.from(capturedOptions?.referenceAudio ?? []), [0.125, -0.125])
  t.is(frames.at(-1)?.stopReason, 'completed')
  t.is(getRequestRegistry().get(requestId), null)
})

test('audioGen plugin operation omits unset controls and audio from the addon call', async (t) => {
  const modelId = 'audio-gen-operation-default-controls'
  const requestId = 'audio-gen-request-default-controls'
  let capturedOptions: GenerateOptions | undefined
  const model = new AudioGen({
    files: {
      textEncModel: 'text-encoder.gguf',
      lmModel: 'lm.gguf',
      ditModel: 'dit.gguf',
      vaeModel: 'vae.gguf'
    }
  })
  model.run = async function (_caption: string, opts?: GenerateOptions) {
    capturedOptions = opts
    return createResponse(
      [{ outputArray: new Int16Array([1, -1]), sampleRate: 48000, channels: 2 }],
      {}
    )
  }
  registerModel(modelId, {
    model: model as unknown as AnyModel,
    path: '',
    config: {},
    modelType: ModelType.audiogenGgml
  })
  t.teardown(() => {
    unregisterModel(modelId)
  })

  for await (const _frame of audioGenStream({
    type: 'audioGenStream',
    requestId,
    modelId,
    caption: 'ambient electronic music',
    seed: 42
  })) {
    // drain
  }

  t.alike(capturedOptions, { seed: 42 }, 'only explicitly provided options reach the addon')
  t.is(getRequestRegistry().get(requestId), null)
})

test('audioGen plugin operation fails fast on undecodable audio without invoking the addon', async (t) => {
  const modelId = 'audio-gen-operation-bad-audio'
  const requestId = 'audio-gen-request-bad-audio'
  let runCalls = 0
  const model = new AudioGen({
    files: {
      textEncModel: 'text-encoder.gguf',
      lmModel: 'lm.gguf',
      ditModel: 'dit.gguf',
      vaeModel: 'vae.gguf'
    }
  })
  model.run = async function () {
    runCalls++
    return createResponse([], {})
  }
  registerModel(modelId, {
    model: model as unknown as AnyModel,
    path: '',
    config: {},
    modelType: ModelType.audiogenGgml
  })
  t.teardown(() => {
    unregisterModel(modelId)
  })

  const stream = audioGenStream({
    type: 'audioGenStream',
    requestId,
    modelId,
    caption: 'orchestral arrangement with dramatic strings',
    taskType: 'cover-nofsq',
    sourceAudio: { type: 'base64', value: Buffer.from([1, 2, 3]).toString('base64') }
  })
  const error = await rejection(stream.next())
  t.ok(error instanceof InvalidAudioInputError, 'malformed source PCM is rejected before the run')
  t.is(runCalls, 0, 'the addon was never invoked')
  t.is(getRequestRegistry().get(requestId), null, 'the request registry entry is released')
})
