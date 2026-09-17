/**
 * Parakeet Nemotron transcription from an audio file.
 *
 * Usage:
 *   bun run examples/asr/parakeet-nemotron-filesystem.ts \
 *     <audio-file> [locale] [nemotron-gguf] [--streaming]
 *   bun run examples/asr/parakeet-nemotron-filesystem.ts \
 *     <audio-file> [nemotron-gguf] [--streaming]
 *
 * Uses `PARAKEET_NEMOTRON_0_6B_Q4_0` when the model is omitted and `auto` when
 * the locale is omitted. Pass `--streaming` to stream decoded 16 kHz mono PCM;
 * otherwise, the input is transcribed in batch mode.
 */
import {
  loadModel,
  PARAKEET_NEMOTRON_0_6B_Q4_0,
  transcribe,
  transcribeStream,
  unloadModel,
  type TranscribeStreamConversationSession
} from '@qvac/sdk'
import { spawn, type ChildProcessByStdio } from 'child_process'
import type { Readable } from 'stream'

const SAMPLE_RATE = 16000
const BYTES_PER_S16_SAMPLE = 2
const INPUT_CHUNK_MS = 160
const MILLISECONDS_PER_SECOND = 1000
const BYTES_PER_MEGABYTE = 1e6
const DEFAULT_LOCALE = 'auto'
const FFMPEG_PROTOCOLS = 'file,pipe'
const STREAMING_FLAG = '--streaming'
const EARLY_OUTPUT_END_MESSAGE = 'The transcription stream ended before the decoder input completed'
const USAGE =
  'Usage: bun run examples/asr/parakeet-nemotron-filesystem.ts ' +
  '<audio-file> [locale] [nemotron-gguf] [--streaming]'

type StreamingSession = TranscribeStreamConversationSession
type Decoder = ChildProcessByStdio<null, Readable, null>

function parseArguments(args: string[]) {
  const streaming = args.includes(STREAMING_FLAG)
  const positional = args.filter((argument) => argument !== STREAMING_FLAG)
  const [audioFilePath, second, third] = positional
  const secondIsModel =
    second !== undefined &&
    (second.endsWith('.gguf') || second.includes('/') || second.includes('\\'))
  const locale = secondIsModel ? DEFAULT_LOCALE : (second ?? DEFAULT_LOCALE)
  const modelSource = secondIsModel ? second : third

  return { audioFilePath, locale, modelSource, streaming }
}

function requireAudioFilePath(audioFilePath: string | undefined): string {
  if (audioFilePath) return audioFilePath

  throw new Error(USAGE)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function calculateChunkBytes(): number {
  const samplesPerChunk = Math.floor((INPUT_CHUNK_MS / MILLISECONDS_PER_SECOND) * SAMPLE_RATE)
  return samplesPerChunk * BYTES_PER_S16_SAMPLE
}

function createDecoder(inputPath: string): Decoder {
  return spawn(
    'ffmpeg',
    [
      '-protocol_whitelist',
      FFMPEG_PROTOCOLS,
      '-i',
      inputPath,
      '-ar',
      String(SAMPLE_RATE),
      '-ac',
      '1',
      '-f',
      's16le',
      'pipe:1'
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  )
}

function waitForDecoder(decoder: Decoder): Promise<Error | null> {
  return new Promise((resolve) => {
    decoder.once('error', resolve)
    decoder.once('close', (code) => {
      if (code === 0) resolve(null)
      else resolve(new Error(`ffmpeg exited with code ${code}`))
    })
  })
}

function stopDecoder(decoder: Decoder | undefined): void {
  if (decoder?.exitCode === null && !decoder.killed) decoder.kill()
}

async function printTranscription(session: StreamingSession): Promise<void> {
  for await (const event of session) {
    if (event.type === 'text' && event.text) process.stdout.write(event.text)
  }
}

async function rejectWhenOutputEnds(output: Promise<void>): Promise<never> {
  await output
  throw new Error(EARLY_OUTPUT_END_MESSAGE)
}

async function writeAvailableChunks(
  session: StreamingSession,
  pcm: Buffer<ArrayBufferLike>,
  chunkBytes: number
): Promise<Buffer<ArrayBufferLike>> {
  let offset = 0

  while (pcm.length - offset >= chunkBytes) {
    session.write(pcm.subarray(offset, offset + chunkBytes))
    offset += chunkBytes
    await delay(INPUT_CHUNK_MS)
  }

  return pcm.subarray(offset)
}

async function feedDecoderOutput(
  session: StreamingSession,
  decoder: Decoder,
  chunkBytes: number
): Promise<Buffer<ArrayBufferLike>> {
  let incomplete: Buffer<ArrayBufferLike> = Buffer.alloc(0)

  for await (const decoded of decoder.stdout) {
    const pcm =
      incomplete.length === 0 ? Buffer.from(decoded) : Buffer.concat([incomplete, decoded])
    incomplete = await writeAvailableChunks(session, pcm, chunkBytes)
  }

  return incomplete
}

async function runStreaming(modelId: string, inputPath: string): Promise<void> {
  const session = await transcribeStream({ modelId, parakeetStreamingConfig: {} })
  const output = printTranscription(session)
  let decoder: Decoder | undefined
  let exited: Promise<Error | null> | undefined
  let feeding: Promise<Buffer<ArrayBufferLike>> | undefined

  try {
    decoder = createDecoder(inputPath)
    exited = waitForDecoder(decoder)
    feeding = feedDecoderOutput(session, decoder, calculateChunkBytes())
    const incomplete = await Promise.race([feeding, rejectWhenOutputEnds(output)])

    const decoderError = await exited
    if (decoderError) throw decoderError
    if (incomplete.length > 0) session.write(incomplete)

    session.end()
    await output
    process.stdout.write('\n')
  } finally {
    stopDecoder(decoder)
    session.destroy()
    await Promise.allSettled([exited, feeding, output])
  }
}

function printDownloadProgress(progress: {
  percentage: number
  downloaded: number
  total: number
}): void {
  const downloaded = (progress.downloaded / BYTES_PER_MEGABYTE).toFixed(1)
  const total = (progress.total / BYTES_PER_MEGABYTE).toFixed(1)
  const percentage = progress.percentage.toFixed(0)
  const line = `Downloading ${percentage}% (${downloaded}/${total} MB)`

  process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
  if (progress.percentage >= 100) process.stderr.write('\n')
}

async function run(): Promise<void> {
  const { audioFilePath, locale, modelSource, streaming } = parseArguments(process.argv.slice(2))
  const inputPath = requireAudioFilePath(audioFilePath)
  let modelId: string | null = null

  try {
    console.log(`Loading Nemotron with locale ${locale}...`)
    modelId = await loadModel({
      modelSrc: modelSource ?? PARAKEET_NEMOTRON_0_6B_Q4_0,
      modelType: 'parakeet-transcription',
      modelConfig: { language: locale, streaming },
      onProgress: printDownloadProgress
    })

    if (streaming) {
      console.log('Streaming with the Nemotron native 320 ms operating point...')
      await runStreaming(modelId, inputPath)
    } else {
      console.log('Transcribing in batch mode...')
      console.log(await transcribe({ modelId, audioChunk: inputPath }))
    }
  } finally {
    if (modelId) await unloadModel({ modelId })
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
