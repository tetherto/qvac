import { z } from 'zod'
import { binaryInput } from '@/serve/lib/binary-input'
import { formBoolean, formNumber } from '@/serve/lib/form-fields'

export const BCI_RESPONSE_FORMATS = ['json', 'text', 'verbose_json', 'srt', 'vtt'] as const
export type BciResponseFormat = (typeof BCI_RESPONSE_FORMATS)[number]

const timesteps = formNumber(z.number().int().positive()).optional()

/** Mirrors `/v1/audio/transcriptions`, with the SDK's sliding-window options for a stream. */
export const bciTranscriptionsBody = z
  .strictObject({
    model: z.string().min(1),
    file: binaryInput(
      'A BCI neural recording: a little-endian `[timesteps u32, channels u32]` header ' +
        'followed by `timesteps * channels` float32 samples.'
    ),
    response_format: z
      .enum(BCI_RESPONSE_FORMATS)
      .optional()
      .describe('Default `json`. A stream takes `json` or `text` only.'),
    stream: formBoolean()
      .optional()
      .describe('Decode in sliding windows and send text as server-sent events. Default false.'),
    window_timesteps: timesteps.describe(
      'Stream only: decode window in 20 ms timesteps. Addon default 1500.'
    ),
    hop_timesteps: timesteps.describe(
      'Stream only: how far the window advances between decodes, below `window_timesteps`. ' +
        'Addon default 500.'
    )
  })
  .superRefine((body, ctx) => {
    if (body.stream !== true) {
      for (const field of ['window_timesteps', 'hop_timesteps'] as const) {
        if (body[field] !== undefined) {
          ctx.addIssue({ code: 'custom', path: [field], message: 'Requires `stream: true`.' })
        }
      }
      return
    }
    if (body.response_format !== undefined && !['json', 'text'].includes(body.response_format)) {
      ctx.addIssue({
        code: 'custom',
        path: ['response_format'],
        message: 'A stream takes `json` or `text` only.'
      })
    }
    if (
      body.window_timesteps !== undefined &&
      body.hop_timesteps !== undefined &&
      body.hop_timesteps >= body.window_timesteps
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['hop_timesteps'],
        message: 'Must be below `window_timesteps`.'
      })
    }
  })

export type BciTranscriptionsBody = z.infer<typeof bciTranscriptionsBody>

export const BCI_FIELD_CODES: Record<string, string> = {
  response_format: 'invalid_response_format',
  window_timesteps: 'invalid_window',
  hop_timesteps: 'invalid_window'
}

const HEADER_BYTES = 8
const FLOAT32_BYTES = 4

/**
 * Checks the recording's header against its length, so a truncated or wrong
 * file is a 400 before the model loads. A stream ignores the timestep count.
 */
export function neuralDataProblem(bytes: Buffer, stream: boolean): string | null {
  if (bytes.length < HEADER_BYTES) {
    return `file: ${bytes.length} bytes is shorter than the 8-byte header.`
  }
  const timestepCount = bytes.readUInt32LE(0)
  const channels = bytes.readUInt32LE(4)
  if (channels === 0) return 'file: the header declares 0 channels.'
  const body = bytes.length - HEADER_BYTES
  if (stream) {
    return body % (channels * FLOAT32_BYTES) === 0
      ? null
      : `file: ${body} sample bytes is not a whole number of ${channels}-channel timesteps.`
  }
  const expected = timestepCount * channels * FLOAT32_BYTES
  return body === expected
    ? null
    : `file: the header declares ${timestepCount}x${channels} samples (${expected} bytes), got ${body}.`
}
