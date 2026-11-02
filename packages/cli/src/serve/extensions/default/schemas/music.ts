import { z } from 'zod'
import {
  AUDIOGEN_REPAINT_MODES,
  AUDIOGEN_TASK_TYPES,
  AUDIOGEN_TRACKS,
  type AudioEditClientParams,
  type AudioGenClientParams,
  type AudioUnderstandClientParams
} from '@qvac/sdk'
import { binaryInput } from '@/serve/lib/binary-input'
import { formBoolean, formJson, formNumber } from '@/serve/lib/form-fields'

// Bodies mirror the SDK's `audioGen()`, `audioEdit()` and `audioUnderstand()`
// arguments, with `model` for `modelId` and uploads for the audio inputs. The
// types are checked here; ranges and cross-field rules (a cover task needs
// `sourceAudio`, `duration` and `maxFrames` exclude each other, ...) are the
// SDK's, and come back as `400 invalid_request`.

const AUDIO_INPUT_NOTE =
  'Any format the SDK audio decoder reads (WAV, MP3, FLAC, ...); name the upload or declare its type so the decoder is picked by extension.'

const int = () => formNumber(z.number().int())
const num = () => formNumber(z.number())
const bool = () => formBoolean()

const lmSampling = {
  lmTemperature: num().optional().describe('LM sampling temperature (ACE-Step default 0.85).'),
  lmTopP: num().optional().describe('LM nucleus-sampling probability (default 0.9).'),
  lmTopK: int().optional().describe('LM top-k cutoff; 0 disables top-k filtering.')
}

const promptMetadata = {
  vocalLanguage: z.string().min(1).optional(),
  bpm: int().optional().describe('Beats per minute; 0 or unset lets the LM infer it.'),
  keyscale: z.string().min(1).optional().describe('Key and scale, e.g. "C minor".'),
  timesignature: z.string().min(1).optional().describe('Time signature, e.g. "4/4".'),
  augmentCaptionWithMetadata: bool()
    .optional()
    .describe('Append BPM, time signature and key to the conditioning caption.')
}

const dcw = {
  dcwEnabled: bool().optional().describe('Apply the Haar DCW sampler correction (default true).'),
  dcwScaler: num().optional(),
  dcwHighScaler: num().optional()
}

const diffusionOverrides = {
  inferenceSteps: int()
    .optional()
    .describe('Diffusion steps for this run, 0..1000; omit to keep the load-time value.'),
  shift: num().optional().describe('ACE-Step DiT timestep shift; omit to keep the load-time value.')
}

export const audioGenerationBody = z.strictObject({
  model: z.string().min(1),
  caption: z.string().min(1).describe('What to generate.'),
  lyrics: z.string().optional(),
  seed: int().optional().describe('RNG seed; the seed used is reported in `stats.metadata.seed`.'),
  ...promptMetadata,
  simpleMode: bool()
    .optional()
    .describe('Treat `caption` as a short query and let the LM write the full request.'),
  rewriteQuery: bool().optional().describe('Let the LM rewrite `caption`, keeping the lyrics.'),
  generateLrc: bool()
    .optional()
    .describe('Return karaoke-style LRC in `stats.lrc` and `stats.lyricsScore`.'),
  computeQualityScore: bool().optional().describe('Report `stats.qualityScore` in [0, 1].'),
  normalizeLoudness: bool()
    .optional()
    .describe('Percentile loudness normalization (default true).'),
  guidanceScale: num()
    .optional()
    .describe('DiT classifier-free guidance scale; 0 resolves per DiT.'),
  track: z
    .enum(AUDIOGEN_TRACKS)
    .optional()
    .describe('Instrument layer the `lego` task regenerates.'),
  duration: num().optional().describe('Approximate length in seconds.'),
  maxFrames: int().optional().describe('MiniMax semantic-frame cap; excludes `duration`.'),
  ...diffusionOverrides,
  cfgScale: num().optional().describe('MiniMax flow classifier-free guidance scale.'),
  ...lmSampling,
  lmCfgScale: num().optional(),
  lmPhase1: bool().optional().describe('Let the LM infer missing metadata before code generation.'),
  ...dcw,
  taskType: z
    .enum(AUDIOGEN_TASK_TYPES)
    .optional()
    .describe('`text2music` (default), `cover-nofsq` (needs `sourceAudio`) or `lego`.'),
  audioCoverStrength: num().optional(),
  coverNoiseStrength: num().optional(),
  audioCodes: formJson(z.array(z.number().int()))
    .optional()
    .describe(
      'Frozen ACE-Step semantic codes to synthesize instead of running the LM, such as `description.audioCodes` from an understanding.'
    ),
  referenceAudio: binaryInput(`Optional timbre reference. ${AUDIO_INPUT_NOTE}`).optional(),
  sourceAudio: binaryInput(
    `Recording to re-render, for \`cover-nofsq\` and \`lego\`. ${AUDIO_INPUT_NOTE}`
  ).optional()
})

const editPrompt = z.strictObject({
  caption: z.string().min(1),
  lyrics: z.string().optional()
})

const editOperation = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('flow-edit'),
    from: editPrompt.describe('Description of the unedited source.'),
    to: editPrompt.describe('Description of the desired audio.'),
    nMin: z.number().optional(),
    nMax: z.number().optional(),
    nAvg: z.number().int().optional()
  }),
  z.strictObject({
    type: z.literal('repaint'),
    caption: z.string().min(1),
    lyrics: z.string().optional(),
    start: z.number().describe('Region start in seconds.'),
    end: z.number().optional().describe('Region end in seconds; omit for the end of the source.'),
    mode: z.enum(AUDIOGEN_REPAINT_MODES).optional(),
    strength: z.number().optional()
  })
])

export const audioEditBody = z.strictObject({
  model: z.string().min(1),
  sourceAudio: binaryInput(`The recording to edit. ${AUDIO_INPUT_NOTE}`),
  operations: formJson(z.array(editOperation).min(1)).describe(
    'Ordered `flow-edit` / `repaint` pipeline, run in array order. In a multipart body, send it as JSON text.'
  ),
  referenceAudio: binaryInput(`Optional timbre reference. ${AUDIO_INPUT_NOTE}`).optional(),
  seed: int().optional().describe('Seeds the first operation; each next one uses seed + index.'),
  ...promptMetadata,
  ...dcw,
  ...diffusionOverrides
})

export const audioUnderstandingBody = z.strictObject({
  model: z.string().min(1),
  sourceAudio: binaryInput(`The recording to describe. ${AUDIO_INPUT_NOTE}`),
  seed: int().optional().describe('Seeds the LM decode.'),
  vocalLanguage: z.string().min(1).optional().describe('Language hint forced into the result.'),
  ...lmSampling
})

export type AudioGenerationBody = z.infer<typeof audioGenerationBody>
export type AudioEditBody = z.infer<typeof audioEditBody>
export type AudioUnderstandingBody = z.infer<typeof audioUnderstandingBody>

type AudioFields = 'model' | 'sourceAudio' | 'referenceAudio'

/** The body's SDK arguments, with the audio inputs passed as file paths. */
export function audioGenParams(
  body: AudioGenerationBody,
  modelId: string,
  audio: { sourceAudio?: string; referenceAudio?: string }
): AudioGenClientParams {
  return { ...sdkFields(body), modelId, ...audio } as AudioGenClientParams
}

export function audioEditParams(
  body: AudioEditBody,
  modelId: string,
  audio: { sourceAudio: string; referenceAudio?: string }
): AudioEditClientParams {
  return { ...sdkFields(body), modelId, ...audio } as AudioEditClientParams
}

export function audioUnderstandParams(
  body: AudioUnderstandingBody,
  modelId: string,
  sourceAudio: string
): AudioUnderstandClientParams {
  return { ...sdkFields(body), modelId, sourceAudio } as AudioUnderstandClientParams
}

function sdkFields<T extends Record<string, unknown>>(body: T): Omit<T, AudioFields> {
  const fields: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (key === 'model' || key === 'sourceAudio' || key === 'referenceAudio') continue
    if (value !== undefined) fields[key] = value
  }
  return fields as Omit<T, AudioFields>
}

const jobStatus = z.enum(['queued', 'in_progress', 'completed', 'failed'])

// Loose, so a stat the SDK adds later still reaches the client.
const audioStats = z.looseObject({
  audioDurationMs: z.number().optional(),
  totalTimeMs: z.number().optional(),
  realTimeFactor: z.number().optional()
})

function jobResource<O extends string>(object: O) {
  return z.object({
    id: z.string(),
    object: z.literal(object),
    model: z.string(),
    status: jobStatus,
    progress: z
      .number()
      .describe('0..100 within the current `stage`; restarts at each stage, 100 once completed.'),
    stage: z.string().nullable().describe('The engine stage last reported, e.g. `lm` or `dit`.'),
    created_at: z.number(),
    completed_at: z.number().nullable(),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
    stats: audioStats
      .nullable()
      .describe(
        "The SDK's run stats once completed: duration, timings, and for ACE-Step the rendered `metadata` (caption, lyrics, seed, ...), `lrc`, `lyricsScore` and `qualityScore` when requested."
      )
  })
}

export const audioGenerationResource = jobResource('audio.generation')
export const audioEditResource = jobResource('audio.edit')

export function jobListResource<T extends z.ZodType>(item: T) {
  return z.object({
    object: z.literal('list'),
    data: z.array(item),
    first_id: z.string().nullable(),
    last_id: z.string().nullable(),
    has_more: z.boolean()
  })
}

export function deletedJobResource<O extends string>(object: O) {
  return z.object({ id: z.string(), object: z.literal(object), deleted: z.literal(true) })
}

export const audioJobIdParam = z.object({ id: z.string().min(1) })

export const audioJobsListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  after: z.string().optional()
})

export const AUDIO_CONTENT_FORMATS = ['wav', 'mp3', 'flac', 'opus', 'aac'] as const

export const audioContentQuery = z.object({
  format: z
    .enum(AUDIO_CONTENT_FORMATS)
    .optional()
    .describe('Container to return; `wav` (default) is native, the others need ffmpeg.')
})

export const audioUnderstandingResult = z.object({
  object: z.literal('audio.understanding'),
  model: z.string(),
  description: z.looseObject({
    caption: z.string(),
    bpm: z.number(),
    duration: z.number().describe('LM estimate in seconds.'),
    keyscale: z.string(),
    timesignature: z.string(),
    vocalLanguage: z.string(),
    audioCodes: z
      .array(z.number())
      .describe('Recovered semantic codes, reusable as a generation `audioCodes`.'),
    seed: z.number()
  }),
  stats: audioStats.optional()
})

export const MUSIC_FIELD_CODES: Record<string, string> = {
  caption: 'missing_caption',
  sourceAudio: 'missing_source_audio',
  operations: 'invalid_operations'
}
