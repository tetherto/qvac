import { z } from 'zod'

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

// ============================================
// Embodiment selection (GR00T only)
// ============================================

// Bounds mirrored from @qvac/vla-ggml: a cat_id indexes GR00T's
// CategorySpecificLinear bank whose category dim the architecture fixes at 32,
// and the native resolver caps camera counts at 64.
const MAX_EMBODIMENT_CAT_ID = 31
const MAX_NUM_CAMERAS = 64

// Sanity bound, not an addon contract — the addon only requires non-empty.
// Real tags are short snake_case identifiers (longest known: 37 chars); the
// cap stops a garbage or hostile string from travelling into the native
// resolver while leaving ample headroom for legitimate tags.
const MAX_EMBODIMENT_TAG_LENGTH = 256

const embodimentTagSchema = z
  .string()
  .min(1)
  .max(MAX_EMBODIMENT_TAG_LENGTH)
  .describe("Embodiment tag string as stored in the GGUF (e.g. 'libero_sim').")

const embodimentCatIdSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_EMBODIMENT_CAT_ID)
  .describe("The embodiment's numeric `cat_id` (0..31).")

const embodimentObjectSchema = z
  .object({
    tag: embodimentTagSchema.optional(),
    catId: embodimentCatIdSchema.optional(),
    numCameras: z
      .number()
      .int()
      .min(1)
      .max(MAX_NUM_CAMERAS)
      .optional()
      .describe(
        'Overrides the camera count stored in the GGUF for the selected ' +
          'embodiment. Required to select an embodiment whose count was ' +
          'unknown at conversion time.'
      )
  })
  .refine((value) => value.tag === undefined || value.catId === undefined, {
    message: 'embodiment accepts either tag or catId, not both'
  })

/**
 * How a GR00T embodiment is named when selecting one: a tag string, its
 * numeric `cat_id` (0..31), or an object carrying either plus an optional
 * camera-count override. Mirrors the addon's `VlaEmbodimentSelector`.
 *
 * On the load path (`config.embodiment`) an object naming neither `tag` nor
 * `catId` is allowed — the GGUF's default embodiment is used, with only the
 * `numCameras` override applied.
 */
export const vlaEmbodimentSelectorSchema = z.union([
  embodimentTagSchema,
  embodimentCatIdSchema,
  embodimentObjectSchema
])

export type VlaEmbodimentSelector = z.input<typeof vlaEmbodimentSelectorSchema>

/**
 * The selector shape `vlaSetEmbodiment` accepts: a switch must name an
 * embodiment, so the neither-tag-nor-catId object form is rejected here
 * (matching the addon's `setEmbodiment` validation).
 */
export const vlaEmbodimentSelectionSchema = z.union([
  embodimentTagSchema,
  embodimentCatIdSchema,
  embodimentObjectSchema.refine((value) => value.tag !== undefined || value.catId !== undefined, {
    message: 'embodiment must name a tag or a catId'
  })
])

/**
 * The static type matching `vlaEmbodimentSelectionSchema`. Hand-written
 * because zod refinements don't narrow the inferred type — `z.input` of the
 * schema would still allow the load-path-only `{ numCameras }` / `{}`
 * spellings that the switch schema rejects at runtime. The `never` fields
 * encode "exactly one of tag / catId" structurally.
 */
export type VlaEmbodimentSelection =
  | string
  | number
  | { tag: string; catId?: never; numCameras?: number }
  | { catId: number; tag?: never; numCameras?: number }

// ============================================
// Load-time config
// ============================================

export const vlaConfigSchema = z.object({
  backend: z
    .enum(['auto', 'cpu'])
    .optional()
    .describe(
      'Backend selection passed to `VlaModel.load({ backend })`. ' +
        "`'auto'` (default) prefers an accepted GPU (Vulkan / Metal / OpenCL) and falls back to CPU. " +
        "`'cpu'` forces CPU regardless of available accelerators."
    ),
  verbosity: z
    .number()
    .int()
    .optional()
    .describe('Native log verbosity forwarded to the addon (0=ERROR, 1=WARN, 2=INFO, 3=DEBUG).'),
  embodiment: vlaEmbodimentSelectorSchema
    .optional()
    .describe(
      'GR00T only: which embodiment of a multi-embodiment GGUF to activate at ' +
        'load — a tag string, a numeric `cat_id` (0..31), or `{ tag | catId, ' +
        "numCameras }`. Omitted = the GGUF's default embodiment. Rejected by " +
        'the addon for non-GR00T models.'
    )
})

export type VlaConfig = z.input<typeof vlaConfigSchema>

// ============================================
// Hparams (returned by the addon after load)
// ============================================

export const vlaHparamsSchema = z.object({
  chunkSize: z.number().int().nonnegative(),
  actionDim: z.number().int().nonnegative(),
  maxActionDim: z.number().int().nonnegative(),
  maxStateDim: z.number().int().nonnegative(),
  tokenizerMaxLength: z.number().int().nonnegative(),
  visionImageSize: z.number().int().nonnegative(),
  numCameras: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Number of camera views the model expects (2 for SmolVLA and GR00T, 3 ' +
        'for π₀.₅). Pass exactly this many preprocessed frames in `images`. ' +
        'Optional for back-compat — older addon builds may omit it.'
    ),
  stateInputMode: z
    .enum(['continuous', 'discrete'])
    .optional()
    .describe(
      "How the robot state is consumed. `'continuous'` (SmolVLA, GR00T): the " +
        '`state` Float32Array is projected by an in-model linear layer. ' +
        "`'discrete'` (π₀.₅): the state is tokenised into the language prompt " +
        'and the `state` buffer is ignored — pass an empty `Float32Array(0)`. ' +
        'Optional for back-compat.'
    ),
  imageInputMode: z
    .enum(['pixels', 'patches'])
    .optional()
    .describe(
      "How images are supplied. `'pixels'` (SmolVLA, π₀.₅): each `images` " +
        'entry is a `3 · imgWidth · imgHeight` CHW plane from ' +
        "`vlaPreprocessImage`. `'patches'` (GR00T): each entry is a " +
        'pre-patchified buffer of length `imagePatchElems`. Optional for ' +
        'back-compat.'
    ),
  imagePatchElems: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "For patch-input models (`imageInputMode === 'patches'`), the exact " +
        'per-camera patch buffer length each `images` entry must have. Absent ' +
        'for pixel-input models.'
    ),
  selectedEmbodimentTag: z
    .string()
    .optional()
    .describe(
      'GR00T only: the embodiment tag resolved at load / after ' +
        '`vlaSetEmbodiment`. Absent for SmolVLA / π₀.₅. Present is not the ' +
        'same as switchable — a single-embodiment GGUF reports its baked tag ' +
        'and still rejects `vlaSetEmbodiment`.'
    ),
  selectedEmbodimentCatId: z
    .number()
    .int()
    .min(0)
    .max(MAX_EMBODIMENT_CAT_ID)
    .optional()
    .describe(
      "The resolved embodiment's numeric `cat_id` — the value to pass back " +
        'to select the same embodiment by id. Absent when no embodiment was ' +
        'resolved (SmolVLA / π₀.₅).'
    )
})

export type VlaHparams = z.infer<typeof vlaHparamsSchema>

// ============================================
// Stats
// ============================================

export const vlaStatsSchema = z.object({
  vision_ms: z.number().optional(),
  // Architecture-neutral prefill timings (emitted by both SmolVLA and π₀.₅).
  prefill_compute_ms: z.number().optional(),
  prefill_total_ms: z.number().optional(),
  // Legacy SmolVLA-named aliases for the prefill timings above; kept for
  // back-compat with consumers written against the original SmolVLA surface.
  smollm2_compute_ms: z.number().optional(),
  smollm2_total_ms: z.number().optional(),
  ode_ms: z.number().optional(),
  total_ms: z.number().optional(),
  backendDevice: z
    .number()
    .optional()
    .describe('0 = CPU backend, 1 = GPU backend (Vulkan / Metal / OpenCL).')
})

export type VlaStats = z.infer<typeof vlaStatsSchema>

// ============================================
// Run request / response (wire format)
//
// Typed arrays travel as base64-encoded ArrayBuffers because JSON-RPC can't
// carry them natively. The client API helpers (`vla()` in client/api/vla.ts)
// keep the consumer-facing `Float32Array | Int32Array | Uint8Array` shape
// and handle the encoding internally.
// ============================================

export const vlaRunRequestSchema = z.object({
  type: z.literal('vlaRun'),
  modelId: z.string(),
  images: z
    .array(z.string().min(1).regex(BASE64_PATTERN))
    .min(1)
    .describe(
      'Base64-encoded preprocessed images, one per camera. Each entry is the ' +
        'underlying ArrayBuffer of a `Float32Array`. For pixel-input models ' +
        '(SmolVLA, π₀.₅) it comes from `vlaPreprocessImage(...)` and its length ' +
        'must equal `3 * imgWidth * imgHeight`. For patch-input models (GR00T, ' +
        "`hparams.imageInputMode === 'patches'`) it is a pre-patchified buffer " +
        'of length `hparams.imagePatchElems`.'
    ),
  imgWidth: z.number().int().positive(),
  imgHeight: z.number().int().positive(),
  state: z
    .string()
    .regex(BASE64_PATTERN)
    .describe(
      'Base64-encoded `Float32Array`. For continuous-state models (SmolVLA, GR00T) ' +
        'this is length `hparams.maxStateDim` — use ' +
        '`vlaPadState(state, hparams.maxStateDim)` to zero-pad. For ' +
        "discrete-state models (π₀.₅, `stateInputMode: 'discrete'`) the state " +
        'is tokenised into the prompt and this buffer is ignored — encode an ' +
        'empty `Float32Array(0)` (which is the empty string).'
    ),
  tokens: z
    .string()
    .min(1)
    .regex(BASE64_PATTERN)
    .describe('Base64-encoded `Int32Array` of length `hparams.tokenizerMaxLength`.'),
  mask: z
    .string()
    .min(1)
    .regex(BASE64_PATTERN)
    .describe('Base64-encoded `Uint8Array` of length `hparams.tokenizerMaxLength`.'),
  noise: z
    .string()
    .min(1)
    .regex(BASE64_PATTERN)
    .optional()
    .describe(
      'Optional base64-encoded `Float32Array` of length ' +
        '`hparams.chunkSize * hparams.maxActionDim`. When omitted the addon ' +
        'samples its own prior.'
    )
})

export type VlaRunRequest = z.input<typeof vlaRunRequestSchema>

export const vlaRunResponseSchema = z.object({
  actions: z
    .string()
    .min(1)
    .regex(BASE64_PATTERN)
    .describe('Base64-encoded `Float32Array` of length `hparams.chunkSize * hparams.actionDim`.'),
  actionDim: z.number().int().positive(),
  chunkSize: z.number().int().positive(),
  stats: vlaStatsSchema.optional()
})

export type VlaRunResponse = z.infer<typeof vlaRunResponseSchema>

// ============================================
// Hparams request / response (plugin handler)
// ============================================

export const vlaHparamsRequestSchema = z.object({
  type: z.literal('vlaHparams'),
  modelId: z.string()
})

export type VlaHparamsRequest = z.input<typeof vlaHparamsRequestSchema>

export const vlaHparamsResponseSchema = z.object({
  hparams: vlaHparamsSchema,
  backendName: z.string().nullable()
})

export type VlaHparamsResponse = z.infer<typeof vlaHparamsResponseSchema>

// ============================================
// Set-embodiment request / response (plugin handler)
// ============================================

export const vlaSetEmbodimentRequestSchema = z.object({
  type: z.literal('vlaSetEmbodiment'),
  modelId: z.string(),
  embodiment: vlaEmbodimentSelectionSchema.describe(
    'The embodiment to switch the loaded GR00T model to — a tag string, a ' +
      'numeric `cat_id` (0..31), or `{ tag | catId, numCameras }`. Must name ' +
      'a tag or a catId.'
  )
})

export type VlaSetEmbodimentRequest = z.input<typeof vlaSetEmbodimentRequestSchema>

export const vlaSetEmbodimentResponseSchema = z.object({
  hparams: vlaHparamsSchema.describe(
    'The refreshed hparams after the switch — `numCameras`, `actionDim` and ' +
      'the `selectedEmbodiment*` fields follow the newly active embodiment.'
  )
})

export type VlaSetEmbodimentResponse = z.infer<typeof vlaSetEmbodimentResponseSchema>

// ============================================
// Client-facing input shapes
// ============================================

export interface VlaClientRunParams {
  modelId: string
  images: Float32Array[]
  imgWidth: number
  imgHeight: number
  state: Float32Array
  tokens: Int32Array
  mask: Uint8Array
  noise?: Float32Array
}

export interface VlaClientRunResult {
  actions: Float32Array
  actionDim: number
  chunkSize: number
  stats?: VlaStats
}
