import { z } from "zod";

const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// ============================================
// Load-time config
// ============================================

export const vlaConfigSchema = z.object({
  backend: z
    .enum(["auto", "cpu"])
    .optional()
    .describe(
      "Backend selection passed to `VlaModel.load({ backend })`. " +
        "`'auto'` (default) prefers an accepted GPU (Vulkan / Metal / OpenCL) and falls back to CPU. " +
        "`'cpu'` forces CPU regardless of available accelerators.",
    ),
  verbosity: z
    .number()
    .int()
    .optional()
    .describe(
      "Native log verbosity forwarded to the addon (0=ERROR, 1=WARN, 2=INFO, 3=DEBUG).",
    ),
});

export type VlaConfig = z.input<typeof vlaConfigSchema>;

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
      "Number of camera views the model expects (2 for SmolVLA, 3 for π₀.₅). " +
        "Pass exactly this many preprocessed frames in `images`. Optional for " +
        "back-compat — older addon builds may omit it.",
    ),
  stateInputMode: z
    .enum(["continuous", "discrete"])
    .optional()
    .describe(
      "How the robot state is consumed. `'continuous'` (SmolVLA): the `state` " +
        "Float32Array is projected by an in-model linear layer. `'discrete'` " +
        "(π₀.₅): the state is tokenised into the language prompt and the `state` " +
        "buffer is ignored — pass an empty `Float32Array(0)`. Optional for back-compat.",
    ),
});

export type VlaHparams = z.infer<typeof vlaHparamsSchema>;

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
    .describe("0 = CPU backend, 1 = GPU backend (Vulkan / Metal / OpenCL)."),
});

export type VlaStats = z.infer<typeof vlaStatsSchema>;

// ============================================
// Run request / response (wire format)
//
// Typed arrays travel as base64-encoded ArrayBuffers because JSON-RPC can't
// carry them natively. The client API helpers (`vla()` in client/api/vla.ts)
// keep the consumer-facing `Float32Array | Int32Array | Uint8Array` shape
// and handle the encoding internally.
// ============================================

export const vlaRunRequestSchema = z.object({
  type: z.literal("vlaRun"),
  modelId: z.string(),
  images: z
    .array(z.string().min(1).regex(BASE64_PATTERN))
    .min(1)
    .describe(
      "Base64-encoded preprocessed images. Each entry is the underlying " +
        "ArrayBuffer of a `Float32Array` produced by `vlaPreprocessImage(...)`. " +
        "Length per image must equal `3 * imgWidth * imgHeight`.",
    ),
  imgWidth: z.number().int().positive(),
  imgHeight: z.number().int().positive(),
  state: z
    .string()
    .regex(BASE64_PATTERN)
    .describe(
      "Base64-encoded `Float32Array`. For continuous-state models (SmolVLA) " +
        "this is length `hparams.maxStateDim` — use " +
        "`vlaPadState(state, hparams.maxStateDim)` to zero-pad. For " +
        "discrete-state models (π₀.₅, `stateInputMode: 'discrete'`) the state " +
        "is tokenised into the prompt and this buffer is ignored — encode an " +
        "empty `Float32Array(0)` (which is the empty string).",
    ),
  tokens: z
    .string()
    .min(1)
    .regex(BASE64_PATTERN)
    .describe(
      "Base64-encoded `Int32Array` of length `hparams.tokenizerMaxLength`.",
    ),
  mask: z
    .string()
    .min(1)
    .regex(BASE64_PATTERN)
    .describe(
      "Base64-encoded `Uint8Array` of length `hparams.tokenizerMaxLength`.",
    ),
  noise: z
    .string()
    .min(1)
    .regex(BASE64_PATTERN)
    .optional()
    .describe(
      "Optional base64-encoded `Float32Array` of length " +
        "`hparams.chunkSize * hparams.maxActionDim`. When omitted the addon " +
        "samples its own prior.",
    ),
});

export type VlaRunRequest = z.input<typeof vlaRunRequestSchema>;

export const vlaRunResponseSchema = z.object({
  actions: z
    .string()
    .min(1)
    .regex(BASE64_PATTERN)
    .describe(
      "Base64-encoded `Float32Array` of length `hparams.chunkSize * hparams.actionDim`.",
    ),
  actionDim: z.number().int().positive(),
  chunkSize: z.number().int().positive(),
  stats: vlaStatsSchema.optional(),
});

export type VlaRunResponse = z.infer<typeof vlaRunResponseSchema>;

// ============================================
// Hparams request / response (plugin handler)
// ============================================

export const vlaHparamsRequestSchema = z.object({
  type: z.literal("vlaHparams"),
  modelId: z.string(),
});

export type VlaHparamsRequest = z.input<typeof vlaHparamsRequestSchema>;

export const vlaHparamsResponseSchema = z.object({
  hparams: vlaHparamsSchema,
  backendName: z.string().nullable(),
});

export type VlaHparamsResponse = z.infer<typeof vlaHparamsResponseSchema>;

// ============================================
// Client-facing input shapes
// ============================================

export interface VlaClientRunParams {
  modelId: string;
  images: Float32Array[];
  imgWidth: number;
  imgHeight: number;
  state: Float32Array;
  tokens: Int32Array;
  mask: Uint8Array;
  noise?: Float32Array;
}

export interface VlaClientRunResult {
  actions: Float32Array;
  actionDim: number;
  chunkSize: number;
  stats?: VlaStats;
}
