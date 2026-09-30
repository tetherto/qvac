/**
 * Configuration object passed to the native BCI addon. `checkConfig`
 * validates the presence of the required sections and rejects unknown keys.
 */
export interface BCIConfigurationParams {
  whisperConfig: Record<string, unknown>;
  contextParams: Record<string, unknown>;
  miscConfig: Record<string, unknown>;
  bciConfig?: Record<string, unknown>;
  backendsDir?: string;
  embedderPath?: string;
}

/**
 * Validates BCI addon configuration. Returns nothing, or throws if invalid.
 */
export function checkConfig(configObject: BCIConfigurationParams): void {
  const requiredSections = [
    "whisperConfig",
    "contextParams",
    "miscConfig",
  ] as const;

  for (const section of requiredSections) {
    if (!configObject[section]) {
      throw new Error(`${section} object is required`);
    }
  }

  validateMainGpu(configObject.contextParams);

  const validWhisperParams = [
    "n_threads",
    "duration_ms",
    "translate",
    "no_timestamps",
    "single_segment",
    "print_special",
    "print_progress",
    "print_realtime",
    "print_timestamps",
    "language",
    "detect_language",
    "suppress_blank",
    "suppress_nst",
    "temperature",
    "greedy_best_of",
    "beam_search_beam_size",
  ];

  const validContextParams = ["model", "use_gpu", "flash_attn", "gpu_device", "main-gpu", "main_gpu"];

  const validMiscParams = ["caption_enabled"];

  const validBCIParams = ["day_idx"];

  for (const userParam of Object.keys(configObject.whisperConfig)) {
    if (!validWhisperParams.includes(userParam)) {
      throw new Error(`${userParam} is not a valid parameter for whisperConfig`);
    }
  }

  for (const userParam of Object.keys(configObject.contextParams)) {
    if (!validContextParams.includes(userParam)) {
      throw new Error(`${userParam} is not a valid parameter for contextParams`);
    }
  }

  for (const userParam of Object.keys(configObject.miscConfig)) {
    if (!validMiscParams.includes(userParam)) {
      throw new Error(`${userParam} is not a valid parameter for miscConfig`);
    }
  }
  if (
    configObject.miscConfig.caption_enabled !== undefined &&
    typeof configObject.miscConfig.caption_enabled !== "boolean"
  ) {
    throw new Error("miscConfig.caption_enabled must be a boolean");
  }

  if (configObject.bciConfig) {
    for (const userParam of Object.keys(configObject.bciConfig)) {
      if (!validBCIParams.includes(userParam)) {
        throw new Error(`${userParam} is not a valid parameter for bciConfig`);
      }
    }
    const dayIdx = configObject.bciConfig.day_idx;
    if (dayIdx !== undefined) {
      if (
        typeof dayIdx !== "number" ||
        !Number.isFinite(dayIdx) ||
        !Number.isInteger(dayIdx)
      ) {
        throw new Error("bciConfig.day_idx must be a finite integer");
      }
      if (dayIdx < -1) {
        throw new Error(
          "bciConfig.day_idx must be >= -1 (use -1 to enable mel-passthrough mode)",
        );
      }
    }
  }
}

/** Shared main-gpu contract; registry bounds are resolved by the native loader. */
function validateMainGpu(contextParams: Record<string, unknown>): void {
  const hasCanonical = Object.hasOwn(contextParams, "main-gpu");
  const hasAlias = Object.hasOwn(contextParams, "main_gpu");
  if (hasCanonical && hasAlias) {
    throw new Error("Use only one of main-gpu and main_gpu");
  }
  if (!hasCanonical && !hasAlias) return;
  if (Object.hasOwn(contextParams, "gpu_device")) {
    throw new Error("main-gpu cannot be combined with gpu_device");
  }
  const value = contextParams[hasCanonical ? "main-gpu" : "main_gpu"];
  if (typeof value === "string" && /^(dedicated|integrated)$/i.test(value)) {
    return;
  }
  const number =
    typeof value === "string" && /^[+-]?\d+$/.test(value)
      ? Number(value)
      : value;
  if (
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    number < -2147483648 ||
    number > 2147483647
  ) {
    throw new Error(
      "main-gpu must be a 32-bit integer registry index, 'dedicated', or 'integrated'",
    );
  }
}
