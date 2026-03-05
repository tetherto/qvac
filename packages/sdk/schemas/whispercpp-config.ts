import { z } from "zod";

export const audioFormatSchema = z.enum(["f32le", "s16le"]);
export type AudioFormat = z.infer<typeof audioFormatSchema>;

const vadParamsSchema = z
  .object({
    threshold: z.number().optional(),
    min_speech_duration_ms: z.number().optional(),
    min_silence_duration_ms: z.number().optional(),
    max_speech_duration_s: z.number().optional(),
    speech_pad_ms: z.number().optional(),
    samples_overlap: z.number().optional(),
  })
  .optional();

const contextParamsSchema = z
  .object({
    model: z.string().optional(),
    use_gpu: z.boolean().optional(),
    flash_attn: z.boolean().optional(),
    gpu_device: z.number().optional(),
  })
  .optional();

const miscConfigSchema = z
  .object({
    caption_enabled: z.boolean().optional(),
  })
  .optional();

export const whisperConfigSchema = z.object({
  strategy: z.enum(["greedy", "beam_search"]).optional(),
  n_threads: z.number().int().optional(),
  n_max_text_ctx: z.number().int().optional(),
  offset_ms: z.number().int().optional(),
  duration_ms: z.number().int().optional(),
  audio_ctx: z.number().int().optional(),
  translate: z.boolean().optional(),
  no_context: z.boolean().optional(),
  no_timestamps: z.boolean().optional(),
  single_segment: z.boolean().optional(),
  print_special: z.boolean().optional(),
  print_progress: z.boolean().optional(),
  print_realtime: z.boolean().optional(),
  print_timestamps: z.boolean().optional(),
  token_timestamps: z.boolean().optional(),
  thold_pt: z.number().optional(),
  thold_ptsum: z.number().optional(),
  max_len: z.number().int().optional(),
  split_on_word: z.boolean().optional(),
  max_tokens: z.number().int().optional(),
  debug_mode: z.boolean().optional(),
  tdrz_enable: z.boolean().optional(),
  suppress_regex: z.string().optional(),
  initial_prompt: z.string().optional(),
  language: z.string().optional(),
  detect_language: z.boolean().optional(),
  suppress_blank: z.boolean().optional(),
  suppress_nst: z.boolean().optional(),
  temperature: z.number().optional(),
  length_penalty: z.number().optional(),
  temperature_inc: z.number().optional(),
  entropy_thold: z.number().optional(),
  logprob_thold: z.number().optional(),
  greedy_best_of: z.number().int().optional(),
  beam_search_beam_size: z.number().int().optional(),
  vad_model_path: z.string().optional(),
  vad_params: vadParamsSchema,
  audio_format: audioFormatSchema.optional(),
  contextParams: contextParamsSchema,
  miscConfig: miscConfigSchema,
});

export type WhisperConfig = z.infer<typeof whisperConfigSchema>;
