import { z } from 'zod'

// `search` (not `q`) for free-text, to avoid confusion with `quantization`.
export const modelCatalogQuery = z.object({
  search: z.string().optional().describe('Substring match on the model id/name.'),
  role: z
    .string()
    .optional()
    .describe('Endpoint category, e.g. chat, embedding, transcription, speech, image.'),
  addon: z.string().optional().describe('SDK addon/category, e.g. llm, tts, whisper, diffusion.'),
  type: z.string().optional().describe('Alias for `addon`.'),
  quantization: z.string().optional().describe('Quantization, e.g. q4, q8_0 (case-insensitive).'),
  engine: z.string().optional().describe('Inference engine, e.g. llamacpp-completion.'),
  configured: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true'))
    .describe('Restrict to configured (true) or catalog-only (false) models.'),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe('Page size. Omit for no limit (returns all matching entries).'),
  offset: z.coerce.number().int().min(0).optional().describe('Rows to skip (default 0).')
})

export const modelCatalogIdParams = z.object({ id: z.string().min(1) })
