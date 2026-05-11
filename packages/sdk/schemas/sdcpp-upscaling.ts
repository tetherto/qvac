import { z } from "zod";

const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const sdcppUpscalingConfigSchema = z.object({
  backendsDir: z.string().optional()
    .describe("Custom backends directory path (defaults to prebuilds/)."),
  tile_size: z.number().int().positive().optional()
    .describe("ESRGAN upscaler tile size in pixels."),
  direct: z.boolean().optional()
    .describe("Use direct convolution in the ESRGAN upscaler."),
  offload_params_to_cpu: z.boolean().optional()
    .describe("Keep ESRGAN weights on CPU and offload them during compute."),
  threads: z.union([
    z.literal(-1),
    z.number().int().positive(),
  ]).optional()
    .describe("Number of CPU threads dedicated to the ESRGAN upscaler. -1 = auto."),
  verbosity: z.number().optional()
    .describe("Logging verbosity: 0=error, 1=warn, 2=info, 3=debug."),
});

export type SdcppUpscalingConfig = z.infer<typeof sdcppUpscalingConfigSchema>;

export const upscaleStatsSchema = z.object({
  modelLoadMs: z.number().optional(),
  upscaleMs: z.number().optional(),
  totalUpscaleMs: z.number().optional(),
  totalWallMs: z.number().optional(),
  totalUpscales: z.number().optional(),
  totalImages: z.number().optional(),
  totalPixels: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  repeats: z.number().optional(),
});

export type UpscaleStats = z.infer<typeof upscaleStatsSchema>;

export const upscaleRequestSchema = z.object({
  modelId: z.string().describe("The identifier of the upscaler model to use."),
  image: z.string().min(1).regex(BASE64_PATTERN)
    .describe("Base64-encoded PNG/JPEG input image bytes."),
  repeats: z.number().int().positive().optional()
    .describe("Number of ESRGAN passes to run. Defaults to 1."),
});

export type UpscaleRequest = z.input<typeof upscaleRequestSchema>;

export const upscaleStreamRequestSchema = upscaleRequestSchema.extend({
  type: z.literal("upscaleStream"),
});

export type UpscaleStreamRequest = z.input<typeof upscaleStreamRequestSchema>;

export const upscaleStreamResponseSchema = z.object({
  type: z.literal("upscaleStream"),
  data: z.string().optional(),
  outputIndex: z.number().optional(),
  done: z.boolean().optional(),
  stats: upscaleStatsSchema.optional(),
});

export type UpscaleStreamResponse = z.infer<
  typeof upscaleStreamResponseSchema
>;

export type UpscaleClientParams = Omit<UpscaleRequest, "image"> & {
  image: Uint8Array;
};
