import { z } from 'zod'

export const transcriptionsBody = z.object({
  model: z.string().min(1),
  file: z.instanceof(Buffer),
  response_format: z.string().optional(),
  prompt: z.string().optional(),
  language: z.string().optional(),
  temperature: z.coerce.number().optional()
}).passthrough()

export const translationsBody = z.object({
  model: z.string().min(1),
  file: z.instanceof(Buffer),
  response_format: z.string().optional(),
  prompt: z.string().optional(),
  language: z.string().optional(),
  temperature: z.coerce.number().optional()
}).passthrough()

export const audioSpeechBody = z.object({
  model: z.string().min(1),
  input: z.string().min(1),
  voice: z.string().optional(),
  response_format: z.string().optional(),
  speed: z.union([z.number(), z.string()]).optional(),
  instructions: z.string().optional(),
  stream_format: z.string().optional()
}).passthrough()

export const SPEECH_UNSUPPORTED_PARAMS = ['speed', 'instructions', 'stream_format'] as const
