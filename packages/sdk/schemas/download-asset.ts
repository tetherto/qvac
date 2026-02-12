import { z } from "zod";
import type { ModelProgressUpdate } from "./load-model";
import { modelSrcInputSchema, modelInputToSrcSchema } from "./model-src-utils";

const downloadAssetOptionsBaseSchema = z.object({
  assetSrc: modelSrcInputSchema,
  seed: z.boolean().optional(),
});

export const downloadAssetOptionsSchema =
  downloadAssetOptionsBaseSchema.transform((data) => ({
    ...data,
    seed: data.seed ?? false,
  }));

export const downloadAssetOptionsToRequestSchema =
  downloadAssetOptionsBaseSchema
    .extend({
      onProgress: z.unknown().optional(),
      withProgress: z.boolean().optional(),
    })
    .transform((data) => ({
      type: "downloadAsset" as const,
      assetSrc: modelInputToSrcSchema.parse(data.assetSrc),
      withProgress: data.withProgress ?? !!data.onProgress,
      seed: data.seed ?? false,
    }));

export const downloadAssetRequestSchema = z
  .object({
    type: z.literal("downloadAsset"),
    assetSrc: z.string(),
    withProgress: z.boolean().optional(),
    seed: z.boolean().optional(),
  })
  .transform((data) => ({
    ...data,
    seed: data.seed ?? false,
  }));

export const downloadAssetResponseSchema = z.object({
  type: z.literal("downloadAsset"),
  success: z.boolean(),
  assetId: z.string().optional(),
  error: z.string().optional(),
});

export const downloadTypeSchema = z.enum(["hyperdrive", "http"]);

export const downloadMetadataSchema = z.object({
  key: z.string(),
  startTime: z.number(),
  type: downloadTypeSchema,
});

export const hyperdriveDownloadMetadataSchema = downloadMetadataSchema.extend({
  type: z.literal("hyperdrive"),
  hyperdriveKey: z.string(),
  modelFileName: z.string(),
});

export const httpDownloadMetadataSchema = downloadMetadataSchema.extend({
  type: z.literal("http"),
  url: z.url(),
  modelPath: z.string(),
});

export type DownloadAssetOptions = z.input<
  typeof downloadAssetOptionsSchema
> & {
  onProgress?: (progress: ModelProgressUpdate) => void;
};
export type DownloadAssetRequest = z.infer<typeof downloadAssetRequestSchema>;
export type DownloadAssetResponse = z.infer<typeof downloadAssetResponseSchema>;
export type DownloadType = z.infer<typeof downloadTypeSchema>;
export type BaseDownloadEntry = z.infer<typeof downloadMetadataSchema> & {
  promise: Promise<string>;
  abortController: AbortController;
  onProgress?: (progress: ModelProgressUpdate) => void;
};
export type HyperdriveDownloadEntry = BaseDownloadEntry &
  z.infer<typeof hyperdriveDownloadMetadataSchema>;
export type HttpDownloadEntry = BaseDownloadEntry &
  z.infer<typeof httpDownloadMetadataSchema>;
export type DownloadEntry = HyperdriveDownloadEntry | HttpDownloadEntry;
