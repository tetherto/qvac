import fs from 'bare-fs'
import path from 'bare-path'
import { FFmpegDecoder, type DecoderOutput } from '@qvac/decoder-audio'
import { FORMATS_NEEDING_DECODE } from '@/constants/audio'
import { Readable } from 'bare-stream'
import Buffer from 'bare-buffer'
import { getEngineLogger } from '@/logging/index'
import { type AudioFormat } from '@/schemas/index'

const logger = getEngineLogger()

export function needsDecoding(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return FORMATS_NEEDING_DECODE.includes(ext)
}

/**
 * Longest silence the decoder may go without emitting a PCM chunk before the
 * decode is abandoned. Measured between outputs, not against the whole file, so
 * long inputs decode fine as long as FFmpeg keeps producing data.
 */
export const DECODER_INACTIVITY_TIMEOUT_MS = 10000

export interface DecodeAudioOptions {
  /** Output sample rate; the decoder's default is 16 kHz (what every transcription engine expects). */
  sampleRate?: number
  /** Inactivity timeout between decoded chunks (default `DECODER_INACTIVITY_TIMEOUT_MS`). */
  inactivityTimeoutMs?: number
}

/** The subset of the decoder's `QvacResponse` that the stream bridge consumes. */
export interface DecoderResponseLike {
  onUpdate(callback: (output: DecoderOutput) => void): DecoderResponseLike
  onFinish(callback: () => void): DecoderResponseLike
  onError(callback: (error: Error) => void): DecoderResponseLike
  await(): Promise<unknown>
}

export interface DecoderStreamOptions {
  /** Used in error messages only. */
  inputPath: string
  inactivityTimeoutMs?: number
  /** Runs once, on whichever terminal path (finish, error, timeout) settles the stream. */
  onSettled?: () => void
}

/**
 * Decode an audio file into a raw mono PCM stream.
 */
export async function decodeAudioToStream(
  inputPath: string,
  audioFormat: AudioFormat = 's16le',
  options: DecodeAudioOptions = {}
): Promise<Readable> {
  const { sampleRate, inactivityTimeoutMs = DECODER_INACTIVITY_TIMEOUT_MS } = options
  const decoder = new FFmpegDecoder({
    config: { audioFormat, ...(sampleRate !== undefined && { sampleRate }) },
    logger
  })

  try {
    await decoder.load()

    const audioStream = fs.createReadStream(inputPath)
    // bare-fs read streams are async-iterable over Buffer at runtime; the
    // decoder types its input as AsyncIterable<Buffer>.
    const response = decoder.run(audioStream as unknown as AsyncIterable<Buffer>)

    return decoderResponseToStream(response, {
      inputPath,
      inactivityTimeoutMs,
      onSettled: () => setImmediate(() => void decoder.unload())
    })
  } catch (error) {
    await decoder.unload()
    logger.error('Decoding failed:', error instanceof Error ? error.message : String(error))
    throw error
  }
}

/**
 * Bridge a decoder response into a `Readable` of PCM chunks. The stream fails
 * if the decoder emits nothing for `inactivityTimeoutMs`; the timer is re-armed
 * on every chunk, so it bounds inactivity, not the total decode time.
 */
export function decoderResponseToStream(
  response: DecoderResponseLike,
  options: DecoderStreamOptions
): Readable {
  const { inputPath, inactivityTimeoutMs = DECODER_INACTIVITY_TIMEOUT_MS, onSettled } = options
  const outputStream = new Readable({
    read() {}
  })

  let hasReceivedData = false
  let hasEnded = false
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  const settle = () => {
    if (hasEnded) return false
    hasEnded = true
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    onSettled?.()
    return true
  }

  const armTimeout = () => {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    timeoutId = setTimeout(() => {
      if (!settle()) return
      outputStream.destroy(
        new Error(
          `Audio decoding produced no output for ${inactivityTimeoutMs}ms for file: ${inputPath}`
        )
      )
    }, inactivityTimeoutMs)
  }
  armTimeout()

  outputStream.on('close', () => {
    settle()
  })

  response
    .onUpdate((output) => {
      hasReceivedData = true
      if (!hasEnded) armTimeout()
      const bytes = new Uint8Array(output.outputArray)
      outputStream.push(Buffer.from(bytes))
    })
    .onFinish(() => {
      if (!settle()) return
      if (!hasReceivedData) {
        outputStream.destroy(new Error(`No audio data decoded from file: ${inputPath}`))
      } else {
        outputStream.push(null)
      }
    })
    .onError((error: Error) => {
      if (!settle()) return
      outputStream.destroy(error)
    })

  response.await().catch((error) => {
    if (!settle()) return
    outputStream.destroy(error instanceof Error ? error : new Error(String(error)))
  })

  return outputStream
}
