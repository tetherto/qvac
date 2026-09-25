import { z } from 'zod'

// OpenAI's built-in speech voices. QVAC has no fixed catalog — these only
// document the names OpenAI clients send; routing still goes through aliases.
export const OPENAI_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'onyx',
  'nova',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar'
] as const

export type OpenAIVoice = (typeof OPENAI_VOICES)[number]

// Mirrors OpenAI's `VoiceIdsOrCustomVoice`: a built-in name, any other
// string, or a custom voice reference `{ id }`.
export const speechVoice = z.union([
  z.enum(OPENAI_VOICES),
  z.string(),
  z.object({ id: z.string().min(1) }).strict()
])

export type SpeechVoice = z.infer<typeof speechVoice>

export const transcriptionsBody = z
  .object({
    model: z.string().min(1),
    file: z.instanceof(Buffer),
    response_format: z.string().optional(),
    prompt: z.string().optional(),
    language: z.string().optional(),
    temperature: z.coerce.number().optional()
  })
  .passthrough()

export const translationsBody = z
  .object({
    model: z.string().min(1),
    file: z.instanceof(Buffer),
    response_format: z.string().optional(),
    prompt: z.string().optional(),
    language: z.string().optional(),
    temperature: z.coerce.number().optional()
  })
  .passthrough()

export const audioSpeechBody = z
  .object({
    model: z.string().min(1),
    input: z.string().min(1),
    voice: speechVoice.optional(),
    response_format: z.string().optional(),
    speed: z.union([z.number(), z.string()]).optional(),
    instructions: z.string().optional(),
    stream_format: z.string().optional()
  })
  .passthrough()

export const SPEECH_UNSUPPORTED_PARAMS = ['speed', 'instructions', 'stream_format'] as const

export const voiceObject = z.object({
  id: z.string(),
  object: z.literal('audio.voice'),
  model: z.string().nullable().describe('`serve.models` alias the voice maps to, if any.')
})

export type VoiceObject = z.infer<typeof voiceObject>

export const voicesListResponse = z.object({
  object: z.literal('list'),
  voices: z.array(z.string()),
  data: z.array(voiceObject)
})
