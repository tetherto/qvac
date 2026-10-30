import { ERR_CODES_PARAKEET, QvacErrorAddonASRGgml } from "../../lib/error";

export interface ParakeetSpeakerAttributionConfig {
  /** Path to the separate diarization GGUF used with the ASR model. */
  modelPath: string;
  mergeSameSpeaker?: boolean;
  minSegmentMs?: number;
  padSegmentMs?: number;
}

const ATTRIBUTION_KEYS = [
  "modelPath",
  "mergeSameSpeaker",
  "minSegmentMs",
  "padSegmentMs",
];
const NATIVE_INT_MAX = 2147483647;

function invalidConfig(message: string): never {
  throw new QvacErrorAddonASRGgml({
    code: ERR_CODES_PARAKEET.INVALID_CONFIG,
    adds: message,
  });
}

export function validateParakeetBackend(backend: unknown): void {
  if (backend !== undefined && typeof backend !== "string") {
    invalidConfig("parakeetConfig.backend must be a string");
  }
}

function validateAttributionKeys(config: Record<string, unknown>): void {
  for (const key of Object.keys(config)) {
    if (!ATTRIBUTION_KEYS.includes(key)) {
      invalidConfig(`${key} is not a valid speakerAttribution parameter`);
    }
  }
}

function validateNativeInteger(value: unknown, key: string): void {
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > NATIVE_INT_MAX
  ) {
    invalidConfig(`speakerAttribution.${key} must be a non-negative native integer`);
  }
}

export function validateSpeakerAttribution(config: unknown): void {
  if (config === undefined) return;
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    invalidConfig("speakerAttribution must be a configuration object");
  }
  const options = config as Record<string, unknown>;
  validateAttributionKeys(options);
  if (typeof options.modelPath !== "string" || !options.modelPath.trim()) {
    invalidConfig("speakerAttribution.modelPath must be a non-empty string");
  }
  if (
    options.mergeSameSpeaker !== undefined &&
    typeof options.mergeSameSpeaker !== "boolean"
  ) {
    invalidConfig("speakerAttribution.mergeSameSpeaker must be a boolean");
  }
  validateNativeInteger(options.minSegmentMs, "minSegmentMs");
  validateNativeInteger(options.padSegmentMs, "padSegmentMs");
}
