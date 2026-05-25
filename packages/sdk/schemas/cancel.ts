import { z } from "zod";

const cancelBaseSchema = z.object({
  type: z.literal("cancel"),
});

/**
 * Public-API base for the broad-cancel escape hatch. Kept exported so
 * the bare-side `cancel({ modelId, kind? })` helper can parse the
 * `modelId` field consistently with the wire envelope.
 */
export const cancelInferenceBaseSchema = z.object({
  modelId: z.string().describe("The model ID to cancel inference for"),
});

/**
 * Coarse kind narrowing for the broad-cancel escape hatch. Matches the
 * server-side `RequestKind` union in `server/bare/runtime/request-context.ts`
 * — keep the two lists in sync. The kind is optional; omitting it
 * cancels every in-flight request on the model regardless of kind
 * (the "cancel everything on this model" sweep used by model-unload
 * and app-shutdown paths).
 */
const cancelKindSchema = z
  .enum([
    "completion",
    "embeddings",
    "transcribe",
    "translate",
    "diffusion",
    "tts",
    "ocr",
    "vla",
    "finetune",
    "loadModel",
    "downloadAsset",
    "rag",
  ] as const)
  .describe(
    "Optional kind narrowing for the broad cancel. Omitting it cancels every in-flight request on the model.",
  );

/**
 * Targeted cancel by `requestId` — the primary cancel path in
 * SDK 0.11.0. Pair with the `requestId` field exposed on
 * `CompletionRun` (and the decorated promises returned by
 * `loadModel(...)`, `downloadAsset(...)`, `embed(...)`,
 * `transcribe(...)`, `rag*(...)` etc.) to cancel a specific in-flight
 * request rather than every request running on a given model.
 *
 * `clearCache` is honoured only when the targeted request is a
 * `downloadAsset` — it propagates onto the underlying download
 * transfer so the partial file is deleted when the last subscriber
 * leaves. Ignored for other kinds.
 */
const cancelByRequestIdParamsSchema = z.object({
  operation: z.literal("request").describe("Operation type"),
  requestId: z
    .string()
    .min(1)
    .describe(
      "Identifier of the specific in-flight request to cancel — the value exposed on the result object returned by long-running calls (e.g. `completion(...)`, `loadModel(...)`, `downloadAsset(...)`).",
    ),
  clearCache: z
    .boolean()
    .optional()
    .describe(
      "Download-only: if true, deletes the partial download file when the subscriber leaves. Ignored for non-download kinds.",
    ),
});

/**
 * Broad cancel escape hatch — abort every in-flight request running on
 * a model (optionally narrowed by `kind`). Kept indefinitely as the
 * non-`requestId` cancel surface for model-unload, app-shutdown, and
 * admin sweeps where the caller doesn't have a `requestId` to hand.
 *
 * Replaces the legacy per-kind discriminator arms (`"inference"`,
 * `"embeddings"`, `"downloadAsset"`, `"rag"`) with a single `"broad"`
 * arm plus an optional `kind` field. The old arms went away as part
 * of the 0.11.0 cleanup once every handler was on the registry; the
 * wire shape collapse is a `[bc]` for any external caller hand-rolling
 * the old RPC envelope. The public-API `cancel(...)` function in
 * `client/api/cancel.ts` keeps the old `{ operation: "inference", modelId }`
 * / `{ operation: "embeddings", modelId }` forms callable and translates
 * them into this new shape at the client boundary, so consumers using
 * the official SDK client see no change.
 */
const cancelBroadParamsSchema = z.object({
  operation: z.literal("broad").describe("Operation type"),
  modelId: z
    .string()
    .describe("Cancel every in-flight request on this model"),
  kind: cancelKindSchema.optional(),
});

const cancelParamsSchema = z.discriminatedUnion("operation", [
  cancelByRequestIdParamsSchema,
  cancelBroadParamsSchema,
]);

export const cancelRequestSchema = z.intersection(
  cancelBaseSchema,
  cancelParamsSchema,
);

export const cancelResponseSchema = z.object({
  type: z.literal("cancel"),
  success: z.boolean(),
  /**
   * Number of in-flight contexts that this call flipped to
   * `cancelling` (already-cancelled contexts are not counted, so
   * callers can rely on the value to log "n requests cancelled" once
   * without double-counting). Always present on `success: true`.
   */
  cancelled: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});

/**
 * Sugar for the most common new path — `cancel({ requestId })`. The
 * client accepts either this shape (no `operation`) or the explicit
 * `{ operation: "request", requestId }` and normalises before sending.
 */
export const cancelByRequestIdSugarSchema = z
  .object({
    requestId: z.string().min(1),
    clearCache: z.boolean().optional(),
  })
  .strict();

/**
 * Sugar for the broad-cancel escape hatch — `cancel({ modelId, kind? })`.
 * Translates to `{ operation: "broad", modelId, kind? }` at the client
 * boundary.
 */
export const cancelBroadSugarSchema = z
  .object({
    modelId: z.string().min(1),
    kind: cancelKindSchema.optional(),
  })
  .strict();

/**
 * Legacy per-kind broad-cancel sugars retained at the public-API
 * boundary so existing callers of `cancel({ operation: "inference",
 * modelId })` / `cancel({ operation: "embeddings", modelId })` keep
 * working without code changes. The client wrapper translates these
 * into the new `{ operation: "broad", modelId, kind: ... }` wire
 * shape. New callers should prefer `cancel({ requestId })` or
 * `cancel({ modelId, kind? })`.
 */
export const cancelLegacyInferenceSugarSchema = z.object({
  operation: z.literal("inference"),
  modelId: z.string().min(1),
});

export const cancelLegacyEmbeddingsSugarSchema = z.object({
  operation: z.literal("embeddings"),
  modelId: z.string().min(1),
});

export type CancelParams = z.infer<typeof cancelParamsSchema>;
export type CancelInferenceBaseParams = z.infer<
  typeof cancelInferenceBaseSchema
>;
export type CancelByRequestIdParams = z.infer<
  typeof cancelByRequestIdParamsSchema
>;
export type CancelBroadParams = z.infer<typeof cancelBroadParamsSchema>;
export type CancelByRequestIdSugar = z.infer<
  typeof cancelByRequestIdSugarSchema
>;
export type CancelBroadSugar = z.infer<typeof cancelBroadSugarSchema>;
export type CancelLegacyInferenceSugar = z.infer<
  typeof cancelLegacyInferenceSugarSchema
>;
export type CancelLegacyEmbeddingsSugar = z.infer<
  typeof cancelLegacyEmbeddingsSugarSchema
>;
export type CancelKind = z.infer<typeof cancelKindSchema>;
export type CancelRequest = z.infer<typeof cancelRequestSchema>;
export type CancelResponse = z.infer<typeof cancelResponseSchema>;

/** Public client-API input — accepts the wire union *or* the requestId/broad sugars and the legacy per-kind sugars. */
export type CancelClientInput =
  | CancelParams
  | CancelByRequestIdSugar
  | CancelBroadSugar
  | CancelLegacyInferenceSugar
  | CancelLegacyEmbeddingsSugar;
