import { z } from 'zod'

// Bounds mirrored from the SDK's embodiment selector: GR00T fixes 32 embodiment
// categories, and the native resolver caps camera counts at 64.
export const MAX_EMBODIMENT_CAT_ID = 31
export const MAX_CAMERAS = 64
const MAX_EMBODIMENT_TAG_LENGTH = 256

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

const base64 = z.string().min(1).regex(BASE64_RE, 'Expected base64.')

const pixelsImage = z.strictObject({
  pixels: base64.describe(
    'Base64 RGB bytes, 8 bits per channel, `width * height * 3` bytes. The server ' +
      "resizes, letterboxes and normalises them to the model's vision size, like the " +
      "SDK's `vlaPreprocessImage()`."
  ),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  layout: z
    .enum(['hwc', 'chw'])
    .optional()
    .describe('Channel layout of `pixels`. Default `hwc` (interleaved RGB).')
})

const tensorImage = z.strictObject({
  tensor: base64.describe(
    'Base64 little-endian float32 values, passed to the model as-is: a `3 x size x size` ' +
      'CHW plane in [-1, 1] for pixel-input models, or the pre-patchified buffer of ' +
      '`hparams.imagePatchElems` values for patch-input models (GR00T).'
  )
})

export const vlaImage = z.union([pixelsImage, tensorImage])

/** Mirrors the SDK's `vla()` arguments, with the buffers as JSON. */
export const vlaActionsBody = z.strictObject({
  model: z.string().min(1),
  images: z
    .array(vlaImage)
    .min(1)
    .max(MAX_CAMERAS)
    .describe('One frame per camera, in the order the model was trained on.'),
  state: z
    .array(z.number())
    .optional()
    .describe(
      'Robot state. Zero-padded to `hparams.maxStateDim`, like `vlaPadState()`. Ignored by ' +
        'discrete-state models (π₀.₅). Default empty.'
    ),
  tokens: z
    .array(z.number().int())
    .min(1)
    .describe(
      "The tokenized instruction, from the model's own tokenizer. Zero-padded to " +
        '`hparams.tokenizerMaxLength`.'
    ),
  attentionMask: z
    .array(z.union([z.literal(0), z.literal(1)]))
    .optional()
    .describe('Attention mask, one entry per token. Default 1 for every token sent.'),
  noise: z
    .array(z.number())
    .optional()
    .describe(
      'Noise prior of `hparams.chunkSize * hparams.maxActionDim` values. Required for GR00T; ' +
        'other models sample their own when omitted.'
    )
})

export type VlaActionsBody = z.infer<typeof vlaActionsBody>
export type VlaImageInput = z.infer<typeof vlaImage>

const embodimentObject = z
  .strictObject({
    tag: z.string().min(1).max(MAX_EMBODIMENT_TAG_LENGTH).optional(),
    catId: z.number().int().min(0).max(MAX_EMBODIMENT_CAT_ID).optional(),
    numCameras: z
      .number()
      .int()
      .min(1)
      .max(MAX_CAMERAS)
      .optional()
      .describe('Overrides the camera count stored in the GGUF for this embodiment.')
  })
  .refine((value) => (value.tag === undefined) !== (value.catId === undefined), {
    message: 'Name exactly one of tag or catId.'
  })

/** Mirrors the SDK's `vlaSetEmbodiment()` arguments. */
export const vlaEmbodimentBody = z.strictObject({
  embodiment: z
    .union([
      z.string().min(1).max(MAX_EMBODIMENT_TAG_LENGTH),
      z.number().int().min(0).max(MAX_EMBODIMENT_CAT_ID),
      embodimentObject
    ])
    .describe(
      'An embodiment tag such as `libero_sim`, a `cat_id` (0..31), or ' +
        '`{ tag | catId, numCameras }`.'
    )
})

export const vlaModelParams = z.strictObject({ model: z.string().min(1) })

// Loose, so a field the SDK adds later still reaches the client.
const hparams = z.looseObject({
  chunkSize: z.number().int(),
  actionDim: z.number().int(),
  maxActionDim: z.number().int(),
  maxStateDim: z.number().int(),
  tokenizerMaxLength: z.number().int(),
  visionImageSize: z.number().int(),
  numCameras: z.number().int().optional(),
  stateInputMode: z.enum(['continuous', 'discrete']).optional(),
  imageInputMode: z.enum(['pixels', 'patches']).optional(),
  imagePatchElems: z.number().int().optional(),
  selectedEmbodimentTag: z.string().optional(),
  selectedEmbodimentCatId: z.number().int().optional()
})

export const vlaModel = z.object({
  object: z.literal('vla.model'),
  model: z.string(),
  backend_name: z
    .string()
    .nullable()
    .optional()
    .describe('The ggml backend the model runs on, such as `Metal`. Not sent after a switch.'),
  hparams: hparams.describe("The SDK's `VlaHparams`, verbatim.")
})

export const vlaActions = z.object({
  object: z.literal('vla.actions'),
  model: z.string(),
  chunk_size: z.number().int(),
  action_dim: z.number().int(),
  actions: z
    .array(z.array(z.number()))
    .describe('`chunk_size` rows of `action_dim` values, in execution order.'),
  stats: z.looseObject({}).describe("The addon's per-stage timings, verbatim.")
})

export const VLA_FIELD_CODES: Record<string, string> = {
  images: 'invalid_images',
  state: 'invalid_state',
  tokens: 'invalid_tokens',
  attentionMask: 'invalid_attention_mask',
  noise: 'invalid_noise',
  embodiment: 'invalid_embodiment'
}
