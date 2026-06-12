import { z } from "zod";

// === BCI (whisper.cpp) engine config ===
//
// Mirrors `BCIWhispercppConfig` from `@qvac/bci-whispercpp`. Unlike the
// flat `whisperConfigSchema`, the BCI addon nests its inference knobs
// under `whisperConfig` and exposes a separate `bciConfig` for
// session-level (neural-signal) parameters.

// Reduced whisper inference field set exposed by the BCI addon (see the
// `WhisperConfig` interface in `@qvac/bci-whispercpp`).
const bciWhisperConfigSchema = z
  .object({
    language: z.string().optional(),
    n_threads: z.number().int().optional(),
    temperature: z.number().optional(),
    suppress_nst: z.boolean().optional(),
    suppress_blank: z.boolean().optional(),
    duration_ms: z.number().int().optional(),
    translate: z.boolean().optional(),
    no_timestamps: z.boolean().optional(),
    single_segment: z.boolean().optional(),
    print_special: z.boolean().optional(),
    print_progress: z.boolean().optional(),
    print_realtime: z.boolean().optional(),
    print_timestamps: z.boolean().optional(),
    detect_language: z.boolean().optional(),
    greedy_best_of: z.number().int().optional(),
    beam_search_beam_size: z.number().int().optional(),
  })
  .optional();

const bciSessionConfigSchema = z
  .object({
    // Session day index used to select day-specific projection matrices.
    // `-1` enables mel passthrough (parity testing only).
    day_idx: z.number().int().optional(),
  })
  .optional();

const bciContextParamsSchema = z
  .object({
    model: z.string().optional(),
    use_gpu: z.boolean().optional(),
    flash_attn: z.boolean().optional(),
    gpu_device: z.number().optional(),
  })
  .optional();

const bciMiscConfigSchema = z
  .object({
    caption_enabled: z.boolean().optional(),
  })
  .optional();

export const bciConfigSchema = z.object({
  whisperConfig: bciWhisperConfigSchema,
  bciConfig: bciSessionConfigSchema,
  contextParams: bciContextParamsSchema,
  miscConfig: bciMiscConfigSchema,
  backendsDir: z.string().optional(),
});

export type BciConfig = z.infer<typeof bciConfigSchema>;
