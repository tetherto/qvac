import { z } from 'zod'
import type Buffer from 'bare-buffer'
import { modelSrcInputSchema } from '@/schemas/model-src-utils'

// Model config — maps to @qvac/ocr-ggml `OcrGgmlParams`. Legacy ONNX-only knobs
// (useGPU, timeout, pipelineMode, decodingMethod, straightenPages) are dropped;
// zod's default (non-strict) object strips them silently if still passed.
export const ocrConfigSchema = z.object({
  langList: z
    .array(z.string())
    .optional()
    .describe(
      "Languages handled by the recognizer, e.g. `['en']` or `['en', 'fr']`. Required for `easyocr`; ignored by the language-agnostic `doctr` pipeline."
    ),
  pipelineType: z
    .enum(['easyocr', 'doctr'])
    .optional()
    .describe(
      "OCR pipeline: `'easyocr'` (CRAFT detector + CRNN recognizer, default) or `'doctr'` (DBNet detector + doctr recognizer, language-agnostic)."
    ),
  magRatio: z
    .number()
    .optional()
    .describe('Detection magnification ratio (easyocr only). Default 1.5.'),
  canvasSize: z
    .number()
    .optional()
    .describe(
      'Detection canvas cap (long side, px) applied after `magRatio` scaling; lower it on memory-constrained targets. Default 2560. easyocr only.'
    ),
  defaultRotationAngles: z
    .array(z.number())
    .optional()
    .describe(
      'Rotation angles tried when the primary pass is low-confidence (easyocr only). Default [90, 270].'
    ),
  contrastRetry: z
    .boolean()
    .optional()
    .describe('Retry low-confidence boxes with contrast adjustment (easyocr only). Default false.'),
  lowConfidenceThreshold: z
    .number()
    .optional()
    .describe(
      'Confidence threshold below which contrast-retry kicks in (easyocr only). Default 0.4.'
    ),
  recognizerBatchSize: z
    .number()
    .optional()
    .describe('Recognizer batch size (easyocr only). Default 32.'),
  nThreads: z
    .number()
    .optional()
    .describe(
      "GGML CPU thread count: `0` (default) auto-detects physical cores, `> 0` sets an explicit count, `< 0` leaves the backend's default unchanged."
    ),
  backendDevice: z
    .enum(['cpu', 'vulkan', 'metal', 'opencl'])
    .optional()
    .describe(
      "ggml backend device: `'cpu'` (default), `'vulkan'`, `'metal'`, or `'opencl'`. Falls back to CPU when the requested GPU device is unavailable."
    ),
  gpuDevice: z
    .number()
    .optional()
    .describe(
      "0-based GPU device index for `'vulkan'`/`'metal'`/`'opencl'`; when omitted, prefers a discrete GPU. Ignored for `'cpu'`."
    ),
  detectorModelSrc: modelSrcInputSchema
    .optional()
    .describe(
      'Text-detector model source (easyocr: CRAFT; doctr: DBNet). Derived from the recognizer model source when omitted.'
    )
})

// Image input types
export const imageInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('base64'),
    value: z.string()
  }),
  z.object({
    type: z.literal('filePath'),
    value: z.string()
  })
])

// OCR options
export const ocrOptionsSchema = z.object({
  paragraph: z.boolean().optional()
})

export const ocrParamsSchema = z.object({
  modelId: z.string(),
  image: imageInputSchema,
  options: ocrOptionsSchema.optional()
})

export const ocrStreamRequestSchema = ocrParamsSchema.extend({
  type: z.literal('ocrStream')
})

export const ocrTextBlockSchema = z.object({
  text: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  confidence: z.number().optional()
})

export const ocrStatsSchema = z.object({
  detectionTime: z.number().optional(),
  recognitionTime: z.number().optional(),
  totalTime: z.number().optional()
})

export const ocrStreamResponseSchema = z.object({
  type: z.literal('ocrStream'),
  blocks: z.array(ocrTextBlockSchema).optional(),
  done: z.boolean().optional(),
  error: z.string().optional(),
  stats: ocrStatsSchema.optional()
})

export type OCRConfig = z.infer<typeof ocrConfigSchema>
export type ImageInput = z.infer<typeof imageInputSchema>
export type OCROptions = z.infer<typeof ocrOptionsSchema>
export type OCRParams = z.infer<typeof ocrParamsSchema>
export type OCRClientParams = {
  modelId: string
  image: string | Buffer
  options?: OCROptions
  stream?: boolean
}
export type OCRStreamRequest = z.infer<typeof ocrStreamRequestSchema>
export type OCRStreamResponse = z.infer<typeof ocrStreamResponseSchema>
export type OCRTextBlock = z.infer<typeof ocrTextBlockSchema>
export type OCRStats = z.infer<typeof ocrStatsSchema>
