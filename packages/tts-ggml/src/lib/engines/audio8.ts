import type { TTSConfigurationParams } from "../../tts";
import { ENGINE_AUDIO8 } from "../engineIds";
import type { EngineSetup, ModelPaths } from "../engineSetup";
import {
  findQuantRankedGguf,
  firstNonEmpty,
  type NormalizedFiles,
} from "../modelFiles";
import { assignBackendParams, assignSamplingParams } from "../nativeParams";
import { setOptionNames } from "../options";

// Audio8 ships three GGUFs per quant tier, with the tier in the filename
// (`audio8-lm-q8_0.gguf`); a bare `audio8-lm.gguf` matches too, as
// forward-compat with a single-tier release.
export const AUDIO8_LM_RE = /^audio8-lm(-[a-z0-9_]+)?\.gguf$/i;
export const AUDIO8_DECODER_RE =
  /^audio8-codec-decoder(-[a-z0-9_]+)?\.gguf$/i;
export const AUDIO8_ENCODER_RE =
  /^audio8-codec-encoder(-[a-z0-9_]+)?\.gguf$/i;
export const AUDIO8_VOICE_KEYS = ["referenceAudio", "referenceText"] as const;
export type Audio8VoiceKey = (typeof AUDIO8_VOICE_KEYS)[number];
export type Audio8VoiceFieldsResolved = Partial<Record<Audio8VoiceKey, string>>;

/**
 * Voice cloning reference. Audio8's codec encoder turns `referenceAudio` into
 * codes and they are prepended to the prompt as the speaker's own history, so
 * no speaker encoder and no enrolment step are involved. `referenceText` is
 * required alongside it there: the model conditions on it as the turn the
 * recording answers, and a wrong one degrades the clone. Accepted at
 * construction, on `reload()`, and per call (Audio8 only).
 */
export interface Audio8VoiceFields {
  /**
   * Chatterbox: voice-cloning reference audio path (wav). CosyVoice3:
   * zero-shot / cross-lingual cloning reference (0.5-30 s hard limits,
   * 5-15 s of clean speech recommended; multichannel input is downmixed to
   * mono) — the native front-end tokenizes it (speech_tokenizer_v3),
   * extracts the CAM++ speaker embedding and prompt mel at load, replacing
   * the baked voice; requires the `cosyvoiceS3tokModel` +
   * `cosyvoiceCampplusModel` files and fails the load (never silently falls
   * back) when they are missing or the audio is unusable. Pair with
   * `promptText` (the verbatim transcript) for zero-shot or omit it for
   * cross-lingual. The reference is fixed at construction: `reload()`
   * re-bakes the same recording (it is forwarded to the new addon instance)
   * but cannot switch to a different one, so changing voices means a new
   * instance. Audio8: the recording to clone, with `referenceText`
   * alongside it. MOSS: the recording to clone, sampled at 24 kHz and
   * fixed at construction; needs `files.mossCodecEncoder`.
   */
  referenceAudio?: string;
  /** Audio8: what `referenceAudio` says. Required when cloning. */
  referenceText?: string;
}

/** The Audio8 sampler knobs a `reload()` may carry. */
export interface Audio8SamplingFields {
  greedy?: boolean;
  temperature?: number;
  topK?: number;
  topP?: number;
  maxFrames?: number;
  seed?: number;
  threads?: number;
}

/**
 * Collect the Audio8 voice-cloning properties present on `source` (a run
 * input, streaming options, or constructor options). Returns undefined when
 * none are set.
 */
export function pickAudio8VoiceFields(
  source: Audio8VoiceFields | null | undefined,
): Audio8VoiceFieldsResolved | undefined {
  if (source == null || typeof source !== "object") return undefined;
  const out: Audio8VoiceFieldsResolved = {};
  let any = false;
  for (const key of AUDIO8_VOICE_KEYS) {
    const value = source[key];
    if (value != null && value !== "") {
      out[key] = String(value);
      any = true;
    }
  }
  return any ? out : undefined;
}

const AUDIO8_NUMERIC_SAMPLING_FIELDS = [
  "temperature",
  "topK",
  "topP",
  "maxFrames",
  "seed",
  "threads",
] as const;

function assertAudio8SamplingFinite(
  sampling: Audio8SamplingFields,
  where: string,
): void {
  for (const field of AUDIO8_NUMERIC_SAMPLING_FIELDS) {
    const value = sampling[field];
    if (value === undefined || Number.isFinite(value)) continue;
    throw new Error(
      `tts-ggml: ${where}: ${field} must be a finite number`,
    );
  }
}

function assertNotNegative(
  value: number | undefined,
  name: string,
  zeroMeans: string,
  where: string,
): void {
  if (value === undefined || value >= 0) return;
  throw new Error(
    `tts-ggml: ${where}: ${name} must be >= 0 (0 = ${zeroMeans})`,
  );
}

function assertAudio8TopP(value: number | undefined, where: string): void {
  if (value === undefined || (value > 0 && value <= 1)) return;
  throw new Error(`tts-ggml: ${where}: topP must be in (0, 1]`);
}

/**
 * Mirrors Audio8Model::validateSampling, which stays the source of truth.
 * Reload checks the merged knobs here because native only sees them when the
 * instance is rebuilt: without this the refused value is already on the JS
 * object by then, and the two would describe different samplers.
 */
export function assertAudio8SamplingValid(
  sampling: Audio8SamplingFields,
  where: string,
): void {
  assertAudio8SamplingFinite(sampling, where);
  assertNotNegative(sampling.temperature, "temperature", "greedy", where);
  assertNotNegative(sampling.topK, "topK", "no top-k cutoff", where);
  assertNotNegative(sampling.maxFrames, "maxFrames", "engine default", where);
  assertAudio8TopP(sampling.topP, where);
}

export function resolveAudio8ModelPaths(
  files: NormalizedFiles,
): Pick<
  ModelPaths,
  "audio8LmPath" | "audio8CodecDecoderPath" | "audio8CodecEncoderPath"
> {
  return {
    audio8LmPath: firstNonEmpty(
      files.audio8Lm,
      findQuantRankedGguf(files.modelDir, AUDIO8_LM_RE),
    ),
    audio8CodecDecoderPath: firstNonEmpty(
      files.audio8CodecDecoder,
      findQuantRankedGguf(files.modelDir, AUDIO8_DECODER_RE),
    ),
    audio8CodecEncoderPath: firstNonEmpty(
      files.audio8CodecEncoder,
      findQuantRankedGguf(files.modelDir, AUDIO8_ENCODER_RE),
    ),
  };
}

/**
 * A recording without its transcript is accepted by the model but degrades
 * the clone silently, and a transcript alone has nothing to attach to, so
 * both halves have to arrive together.
 */
export function assertAudio8VoiceConsistent(
  voice: Audio8VoiceFields,
  codecEncoderPath: string | undefined,
  where: string,
): void {
  if (!voice.referenceAudio && !voice.referenceText) return;
  if (!voice.referenceAudio) {
    throw new Error(
      `tts-ggml: ${where}: referenceText needs a referenceAudio to ` +
        "transcribe",
    );
  }
  if (!voice.referenceText) {
    throw new Error(
      `tts-ggml: ${where}: referenceAudio needs a referenceText saying ` +
        "what the recording says",
    );
  }
  if (!codecEncoderPath) {
    throw new Error(
      `tts-ggml: ${where}: voice cloning needs the audio8 codec encoder ` +
        "GGUF (files.audio8CodecEncoder)",
    );
  }
}

export function assertAudio8Options(setup: EngineSetup): void {
  if (setup.engineType === ENGINE_AUDIO8) {
    if (setup.backend.enhancerGgufPath || setup.backend.denoiserGgufPath) {
      throw new Error(
        "tts-ggml: the LavaSR enhancer/denoiser are not supported with " +
          "the audio8 engine (native 44.1 kHz output needs no bandwidth " +
          "extension). Drop lavasrEnhancer / lavasrDenoiser.",
      );
    }
    assertAudio8VoiceConsistent(
      {
        referenceAudio: setup.settings.referenceAudio,
        referenceText: setup.settings.referenceText,
      },
      setup.paths.audio8CodecEncoderPath,
      "constructor",
    );
    return;
  }
  const audio8Only = setOptionNames({
    referenceText: setup.settings.referenceText,
    greedy: setup.settings.greedy,
  });
  if (audio8Only.length > 0) {
    throw new Error(
      `tts-ggml: ${audio8Only.join(", ")} are audio8-only options ` +
        `(engine is ${setup.engineType})`,
    );
  }
}

/**
 * The voice a per-call override actually synthesizes with. Mirrors
 * Audio8Model::resolveVoice: a per-call recording replaces both halves, so
 * it cannot inherit the configured transcript, which describes a different
 * recording; a per-call transcript alone corrects the configured one.
 */
function mergeAudio8Voice(
  setup: EngineSetup,
  fields: Audio8VoiceFieldsResolved,
): Audio8VoiceFields {
  if (fields.referenceAudio) {
    return {
      referenceAudio: fields.referenceAudio,
      referenceText: fields.referenceText,
    };
  }
  return {
    referenceAudio: setup.settings.referenceAudio,
    referenceText: fields.referenceText ?? setup.settings.referenceText,
  };
}

/**
 * Extract + validate the per-call Audio8 voice fields from a run input or
 * streaming options. Returns undefined when none are present.
 */
export function resolveAudio8JobFields(
  setup: EngineSetup,
  source: Audio8VoiceFields | null | undefined,
  where: string,
): Audio8VoiceFieldsResolved | undefined {
  const fields = pickAudio8VoiceFields(source);
  if (!fields) return undefined;
  if (setup.engineType !== ENGINE_AUDIO8) {
    throw new Error(
      `tts-ggml: ${where}: per-call referenceAudio/referenceText are ` +
        `audio8-only (engine is ${setup.engineType})`,
    );
  }
  assertAudio8VoiceConsistent(
    mergeAudio8Voice(setup, fields),
    setup.paths.audio8CodecEncoderPath,
    where,
  );
  return fields;
}

export function buildAudio8Params(
  setup: EngineSetup,
): TTSConfigurationParams {
  // Backstop for callers that reach the params build by another route than
  // the constructor or applyAudio8Reload, both of which check first.
  assertAudio8VoiceConsistent(
    {
      referenceAudio: setup.settings.referenceAudio,
      referenceText: setup.settings.referenceText,
    },
    setup.paths.audio8CodecEncoderPath,
    "reload",
  );
  const parameters: TTSConfigurationParams = {
    engineType: ENGINE_AUDIO8,
    audio8LmPath: setup.paths.audio8LmPath || "",
    audio8CodecDecoderPath: setup.paths.audio8CodecDecoderPath || "",
  };
  if (setup.paths.audio8CodecEncoderPath) {
    parameters.audio8CodecEncoderPath = setup.paths.audio8CodecEncoderPath;
  }
  if (setup.settings.referenceAudio != null) {
    parameters.referenceAudio = setup.settings.referenceAudio;
  }
  if (setup.settings.referenceText != null) {
    parameters.referenceText = setup.settings.referenceText;
  }
  if (setup.settings.greedy != null) parameters.greedy = !!setup.settings.greedy;
  assignSamplingParams(setup, parameters);
  assignBackendParams(setup, parameters);
  return parameters;
}

/**
 * The voice a reload lands on. Same rule as mergeAudio8Voice and
 * Audio8Model::resolveVoice: a new recording replaces both halves, because
 * the configured transcript describes the recording being replaced. Reload
 * reads `undefined` as "not supplied", so an explicit empty string reaches
 * the guard instead of being ignored.
 */
function mergeAudio8ReloadVoice(
  setup: EngineSetup,
  config: Audio8VoiceFields,
): Audio8VoiceFields {
  if (config.referenceAudio !== undefined) {
    return {
      referenceAudio: config.referenceAudio,
      referenceText: config.referenceText,
    };
  }
  return {
    referenceAudio: setup.settings.referenceAudio,
    referenceText:
      config.referenceText !== undefined
        ? config.referenceText
        : setup.settings.referenceText,
  };
}

/**
 * The knobs a reload lands on, merged the same way as the voice so the
 * whole set can be checked before any of it is written.
 */
function mergeAudio8ReloadSampling(
  setup: EngineSetup,
  config: Audio8SamplingFields,
): Audio8SamplingFields {
  return {
    greedy: config.greedy ?? setup.settings.greedy,
    temperature: config.temperature ?? setup.settings.temperature,
    topK: config.topK ?? setup.settings.topK,
    topP: config.topP ?? setup.settings.topP,
    maxFrames: config.maxFrames ?? setup.settings.maxFrames,
    seed: config.seed ?? setup.settings.seed,
    threads: config.threads ?? setup.settings.threads,
  };
}

function applyAudio8Sampling(
  setup: EngineSetup,
  config: Audio8SamplingFields,
): void {
  if (config.greedy !== undefined) setup.settings.greedy = config.greedy;
  if (config.temperature !== undefined) {
    setup.settings.temperature = config.temperature;
  }
  if (config.topK !== undefined) setup.settings.topK = config.topK;
  if (config.topP !== undefined) setup.settings.topP = config.topP;
  if (config.maxFrames !== undefined) {
    setup.settings.maxFrames = config.maxFrames;
  }
  if (config.seed !== undefined) setup.settings.seed = config.seed;
  if (config.threads !== undefined) setup.settings.threads = config.threads;
}

/**
 * Audio8 voice + sampling knobs are reloadable; they rebuild the engine's
 * sampler and speaker history. Both merges are checked before either is
 * written, so a rejected reload leaves the instance exactly as it was
 * rather than half-moved onto the configuration that was refused.
 */
export function applyAudio8Reload(
  setup: EngineSetup,
  newConfig: Record<string, unknown>,
): void {
  if (setup.engineType !== ENGINE_AUDIO8) return;
  const config = newConfig as Audio8VoiceFields & Audio8SamplingFields;
  const voice = mergeAudio8ReloadVoice(setup, config);
  const sampling = mergeAudio8ReloadSampling(setup, config);
  assertAudio8VoiceConsistent(voice, setup.paths.audio8CodecEncoderPath, "reload");
  assertAudio8SamplingValid(sampling, "reload");
  setup.settings.referenceAudio = voice.referenceAudio;
  setup.settings.referenceText = voice.referenceText;
  applyAudio8Sampling(setup, sampling);
}
