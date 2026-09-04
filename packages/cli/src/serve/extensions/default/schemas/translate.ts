import { z } from 'zod'

/** NMT inference is ungated on its own model, so the batch size bounds native work. */
export const MAX_BATCH_INPUTS = 100

/** Mirrors the SDK's NMT `translate()` arguments. */
export const translateBody = z.strictObject({
  model: z.string().min(1),
  text: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(MAX_BATCH_INPUTS)]),
  stream: z.boolean().optional()
})

/** The `translate()` model types that map to the `translation` category. */
export type NmtModelType = 'nmt' | 'nmtcpp-translation'

// Loose, so a stat the SDK adds later still reaches the client through the
// response serializer.
const translationStats = z.looseObject({
  totalTime: z.number().optional(),
  totalTokens: z.number().optional(),
  tokensPerSecond: z.number().optional(),
  timeToFirstToken: z.number().optional(),
  decodeTime: z.number().optional(),
  encodeTime: z.number().optional(),
  cacheTokens: z.number().optional()
})

export const translationResult = z.object({
  object: z.literal('translation'),
  model: z.string(),
  translations: z.array(z.string()),
  stats: translationStats.optional()
})

export const TRANSLATE_FIELD_CODES: Record<string, string> = {
  text: 'missing_text',
  'text:too_big': 'too_many_inputs'
}
