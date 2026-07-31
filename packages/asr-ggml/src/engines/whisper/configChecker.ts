export interface WhisperConfigurationParams {
  whisperConfig: Record<string, unknown>;
  contextParams: Record<string, unknown>;
  miscConfig: Record<string, unknown>;
  audio_format?: string;
  backendsDir?: string;
  /** Unified native `createInstance` dispatch key; ignored by the checker. */
  engineType?: string;
}

const REQUIRED_SECTIONS = [
  "whisperConfig",
  "contextParams",
  "miscConfig",
] as const;

const WHISPER_CONFIG_KEYS = [
  "strategy",
  "n_threads",
  "n_max_text_ctx",
  "offset_ms",
  "duration_ms",
  "translate",
  "no_context",
  "no_timestamps",
  "single_segment",
  "print_special",
  "print_progress",
  "print_realtime",
  "print_timestamps",
  "token_timestamps",
  "thold_pt",
  "thold_ptsum",
  "max_len",
  "split_on_word",
  "max_tokens",
  "debug_mode",
  "audio_ctx",
  "tdrz_enable",
  "suppress_regex",
  "initial_prompt",
  "language",
  "suppress_blank",
  "suppress_nst",
  "temperature",
  "max_initial_ts",
  "length_penalty",
  "temperature_inc",
  "entropy_thold",
  "logprob_thold",
  "no_speech_thold",
  "greedy_best_of",
  "beam_search_beam_size",
  "vad_model_path",
  "seed",
  "vadParams",
];

const VAD_PARAM_KEYS = [
  "threshold",
  "min_speech_duration_ms",
  "min_silence_duration_ms",
  "max_speech_duration_s",
  "speech_pad_ms",
  "samples_overlap",
];

const CONTEXT_PARAM_KEYS = ["model", "use_gpu", "flash_attn", "gpu_device"];
const MISC_PARAM_KEYS = ["caption_enabled", "seed"];
const MAX_SUPPRESS_REGEX_LENGTH = 512;
const SAFE_SUPPRESS_REGEX = /^[^()]*$/;

export function checkConfig(configObject: WhisperConfigurationParams): void {
  validateRequiredSections(configObject);
  validateMiscConfigKeys(configObject.miscConfig);
  validateWhisperConfigKeys(configObject.whisperConfig);
  validateVadParamsKeys(configObject.whisperConfig.vadParams);
  validateContextParamsKeys(configObject.contextParams);
  validateSuppressRegex(configObject.whisperConfig.suppress_regex);
}

function validateRequiredSections(
  configObject: WhisperConfigurationParams,
): void {
  for (const section of REQUIRED_SECTIONS) {
    if (!configObject[section]) {
      throw new Error(`${section} object is required`);
    }
  }
}

function assertKnownKeys(
  values: Record<string, unknown>,
  allowedKeys: string[],
  sectionName: string,
): void {
  for (const key of Object.keys(values)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`${key} is not a valid parameter for ${sectionName}`);
    }
  }
}

function validateMiscConfigKeys(miscConfig: Record<string, unknown>): void {
  assertKnownKeys(miscConfig, MISC_PARAM_KEYS, "miscConfig");
}

function validateWhisperConfigKeys(
  whisperConfig: Record<string, unknown>,
): void {
  assertKnownKeys(whisperConfig, WHISPER_CONFIG_KEYS, "whisperConfig");
}

function validateVadParamsKeys(vadParams: unknown): void {
  if (!vadParams) return;
  assertKnownKeys(
    vadParams as Record<string, unknown>,
    VAD_PARAM_KEYS,
    "vadParams",
  );
}

function validateContextParamsKeys(
  contextParams: Record<string, unknown>,
): void {
  assertKnownKeys(contextParams, CONTEXT_PARAM_KEYS, "contextParams");
}

function validateSuppressRegex(pattern: unknown): void {
  if (typeof pattern !== "string") return;
  if (pattern.length > MAX_SUPPRESS_REGEX_LENGTH) {
    throw new Error(
      `suppress_regex exceeds maximum length of ${MAX_SUPPRESS_REGEX_LENGTH} characters`,
    );
  }
  if (!SAFE_SUPPRESS_REGEX.test(pattern)) {
    throw new Error(
      "suppress_regex must not contain grouping constructs (parentheses) to prevent catastrophic backtracking",
    );
  }
}
