import type { TTSConfigurationParams } from "../../tts";
import { ENGINE_MOSS_SFX } from "../engineIds";
import type { EngineSetup, ModelPaths } from "../engineSetup";
import {
  findQuantRankedGguf,
  firstNonEmpty,
  type NormalizedFiles,
} from "../modelFiles";
import { assignBackendParams } from "../nativeParams";

export const MOSS_SFX_RE = /^moss-sfx(-[a-z0-9_]+)*\.gguf$/i;
export const MOSS_SFX_NATIVE_SAMPLE_RATE = 48000;
export const MOSS_SFX_MAX_SECONDS = 30;
export const MOSS_SFX_MAX_STEPS = 1000;
export const MOSS_SFX_MAX_GUIDANCE = 50;
export const MOSS_SFX_MAX_SHIFT = 100;
export const MOSS_SFX_CALL_KEYS = [
  "seconds",
  "negativePrompt",
  "steps",
  "guidance",
  "shift",
] as const;

/**
 * MOSS-SoundEffect per-call generation controls (moss-sfx only). Each one is
 * optional; unset `steps` / `guidance` / `shift` use the defaults stored in the
 * model file (100 steps, guidance 4, shift 5).
 */
export interface MossSoundEffectFields {
  /** Length of the sound effect, in (0, 30] seconds, rounded to 0.1 s. Defaults to 10. */
  seconds?: number;
  /** What the sound effect should avoid (classifier-free guidance negative). */
  negativePrompt?: string;
  /** Diffusion steps, 1..1000. More steps cost proportionally more time. */
  steps?: number;
  /** Classifier-free guidance scale, 1..50; 1 skips the negative branch. */
  guidance?: number;
  /** Flow-matching schedule shift, (0, 100]. */
  shift?: number;
}

function assertSoundEffectRange(
  name: string,
  value: unknown,
  accepts: (n: number) => boolean,
  range: string,
): void {
  if (typeof value === "number" && Number.isFinite(value) && accepts(value)) return;
  throw new Error(`tts-ggml: moss-sfx ${name} must be ${range} (got ${String(value)})`);
}

export function assertSoundEffectFields(fields: MossSoundEffectFields): void {
  if (fields.seconds !== undefined) {
    assertSoundEffectRange("seconds", fields.seconds, (n) => n > 0 && n <= MOSS_SFX_MAX_SECONDS,
      `in (0, ${MOSS_SFX_MAX_SECONDS}]`);
  }
  if (fields.steps !== undefined) {
    assertSoundEffectRange("steps", fields.steps,
      (n) => Number.isInteger(n) && n >= 1 && n <= MOSS_SFX_MAX_STEPS, `an integer in [1, ${MOSS_SFX_MAX_STEPS}]`);
  }
  if (fields.guidance !== undefined) {
    assertSoundEffectRange("guidance", fields.guidance, (n) => n >= 1 && n <= MOSS_SFX_MAX_GUIDANCE,
      `in [1, ${MOSS_SFX_MAX_GUIDANCE}]`);
  }
  if (fields.shift !== undefined) {
    assertSoundEffectRange("shift", fields.shift, (n) => n > 0 && n <= MOSS_SFX_MAX_SHIFT,
      `in (0, ${MOSS_SFX_MAX_SHIFT}]`);
  }
  if (fields.negativePrompt !== undefined && typeof fields.negativePrompt !== "string") {
    throw new Error("tts-ggml: moss-sfx negativePrompt must be a string");
  }
}

/**
 * Collect the MOSS-SoundEffect generation controls present on `source`.
 * Returns undefined when none are set.
 */
export function pickSoundEffectFields(
  source: MossSoundEffectFields | null | undefined,
): MossSoundEffectFields | undefined {
  if (source == null || typeof source !== "object") return undefined;
  const present = MOSS_SFX_CALL_KEYS.filter((key) => source[key] !== undefined);
  if (present.length === 0) return undefined;
  return Object.fromEntries(present.map((key) => [key, source[key]]));
}

export function resolveMossSoundEffectModelPaths(
  files: NormalizedFiles,
): Pick<ModelPaths, "mossSoundEffectPath"> {
  return {
    mossSoundEffectPath: firstNonEmpty(
      files.mossSoundEffect,
      findQuantRankedGguf(files.modelDir, MOSS_SFX_RE),
    ),
  };
}

export function assertMossSoundEffectOptions(setup: EngineSetup): void {
  if (setup.engineType !== ENGINE_MOSS_SFX) return;
  if (setup.backend.enhancerGgufPath || setup.backend.denoiserGgufPath) {
    throw new Error(
      "tts-ggml: the LavaSR enhancer/denoiser are not supported with " +
        "the moss-sfx engine. Drop lavasrEnhancer / lavasrDenoiser.",
    );
  }
  if (setup.settings.referenceAudio) {
    throw new Error(
      "tts-ggml: referenceAudio is not supported by the moss-sfx engine, " +
        "which generates sound effects from a text prompt",
    );
  }
  if (setup.settings.steps != null) {
    throw new Error(
      "tts-ggml: the moss-sfx engine takes steps per call " +
        "(run({ input, steps })), not in the constructor",
    );
  }
  assertMossSoundEffectOutputRate(setup);
  if (!setup.paths.mossSoundEffectPath) {
    throw new Error(
      "tts-ggml: the moss-sfx engine needs its GGUF: stage " +
        "moss-sfx-*.gguf in modelDir or set files.mossSoundEffect",
    );
  }
}

function assertMossSoundEffectOutputRate(setup: EngineSetup): void {
  if (
    setup.outputSampleRate == null ||
    setup.outputSampleRate === MOSS_SFX_NATIVE_SAMPLE_RATE
  ) {
    return;
  }
  throw new Error(
    `tts-ggml: the moss-sfx engine outputs ${MOSS_SFX_NATIVE_SAMPLE_RATE} Hz ` +
      `audio and cannot resample (outputSampleRate=${setup.outputSampleRate})`,
  );
}

/**
 * Extract + validate the per-call MOSS-SoundEffect controls from a run
 * input. Returns undefined when none are present.
 */
export function resolveSoundEffectJobFields(
  setup: EngineSetup,
  source: MossSoundEffectFields | null | undefined,
  where: string,
): MossSoundEffectFields | undefined {
  const fields = pickSoundEffectFields(source);
  if (!fields) return undefined;
  if (setup.engineType !== ENGINE_MOSS_SFX) {
    throw new Error(
      `tts-ggml: ${where}: ${Object.keys(fields).join(", ")} are ` +
        `moss-sfx-only options (engine is ${setup.engineType})`,
    );
  }
  assertSoundEffectFields(fields);
  return fields;
}

export function buildMossSoundEffectParams(
  setup: EngineSetup,
): TTSConfigurationParams {
  assertMossSoundEffectOutputRate(setup);
  const parameters: TTSConfigurationParams = {
    engineType: ENGINE_MOSS_SFX,
    mossSoundEffectPath: setup.paths.mossSoundEffectPath || "",
  };
  assignBackendParams(setup, parameters);
  return parameters;
}
