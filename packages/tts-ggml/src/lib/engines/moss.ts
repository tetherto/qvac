import type { TTSConfigurationParams } from "../../tts";
import { ENGINE_MOSS } from "../engineIds";
import type { EngineSetup, ModelPaths, SynthesisSettings } from "../engineSetup";
import {
  findQuantRankedGguf,
  firstNonEmpty,
  type NormalizedFiles,
} from "../modelFiles";
import { assignBackendParams } from "../nativeParams";
import { setOptionNames } from "../options";

export const MOSS_BACKBONE_RE = /^moss-tts-delay(-[a-z0-9_]+)?\.gguf$/i;
export const MOSS_DIALOGUE_BACKBONE_RE = /^moss-ttsd(-[a-z0-9_]+)?\.gguf$/i;
export const MOSS_DECODER_RE = /^moss-codec-decoder(-[a-z0-9_]+)?\.gguf$/i;
export const MOSS_ENCODER_RE = /^moss-codec-encoder(-[a-z0-9_]+)?\.gguf$/i;
export const MOSS_NATIVE_SAMPLE_RATE = 24000;
export const MOSS_FRAMES_PER_SECOND = 12.5;
export const MOSS_MAX_NEW_TOKENS = 2048;
export const MOSS_MAX_CHANNELS = 32;
export const MOSS_TERMINATION_ROWS = 2;
export const MOSS_MAX_DURATION_TOKENS =
  MOSS_MAX_NEW_TOKENS - (MOSS_MAX_CHANNELS - 1) - MOSS_TERMINATION_ROWS;
export const MOSS_INSTANCE_VOICE_KEYS = ["referenceAudio", "dialogueReferences"] as const;

function isValidDurationTokens(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MOSS_MAX_DURATION_TOKENS;
}

export function assertMossDurationTokens(value: number | null | undefined, where: string): void {
  if (value == null || isValidDurationTokens(value)) return;
  throw new Error(
    `tts-ggml: ${where}: durationTokens must be an integer from 0 to ` +
      `${MOSS_MAX_DURATION_TOKENS} (0 = free length)`,
  );
}

function copyDialogueReferences(references: unknown): string[] | undefined {
  if (references == null) return undefined;
  return Array.isArray(references)
    ? [...(references as string[])]
    : (references as string[]);
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value !== "";
}

function assertDialogueReferenceList(references: unknown): void {
  if (
    Array.isArray(references) &&
    references.length > 0 &&
    references.every(isNonEmptyString)
  ) {
    return;
  }
  throw new Error(
    "tts-ggml: dialogueReferences must be a non-empty array of WAV paths, " +
      "one per speaker",
  );
}

/** Dialogue synthesis needs the MOSS-TTSD backbone; plain TTS takes either. */
function mossBackbonePatterns(dialogue: boolean): RegExp[] {
  return dialogue
    ? [MOSS_DIALOGUE_BACKBONE_RE]
    : [MOSS_BACKBONE_RE, MOSS_DIALOGUE_BACKBONE_RE];
}

function findMossBackbone(
  modelDir: string | undefined,
  dialogue: boolean,
): string | undefined {
  return firstNonEmpty(
    ...mossBackbonePatterns(dialogue).map((pattern) =>
      findQuantRankedGguf(modelDir, pattern),
    ),
  );
}

export function resolveMossModelPaths(
  files: NormalizedFiles,
  dialogue: boolean,
): Pick<
  ModelPaths,
  "mossBackbonePath" | "mossCodecDecoderPath" | "mossCodecEncoderPath"
> {
  return {
    mossBackbonePath: firstNonEmpty(
      files.mossBackbone,
      findMossBackbone(files.modelDir, dialogue),
    ),
    mossCodecDecoderPath: firstNonEmpty(
      files.mossCodecDecoder,
      findQuantRankedGguf(files.modelDir, MOSS_DECODER_RE),
    ),
    mossCodecEncoderPath: firstNonEmpty(
      files.mossCodecEncoder,
      findQuantRankedGguf(files.modelDir, MOSS_ENCODER_RE),
    ),
  };
}

/** The MOSS voice and length options, read before model paths are resolved. */
export function mossVoiceSettings(options: {
  dialogueReferences?: string[];
  durationTokens?: number;
}): Pick<SynthesisSettings, "dialogueReferences" | "durationTokens"> {
  return {
    dialogueReferences: copyDialogueReferences(options.dialogueReferences),
    durationTokens: options.durationTokens ?? undefined,
  };
}

export function assertMossOptions(setup: EngineSetup): void {
  if (setup.engineType !== ENGINE_MOSS) {
    assertNoMossOnlyOptions(setup);
    return;
  }
  if (setup.backend.enhancerGgufPath || setup.backend.denoiserGgufPath) {
    throw new Error(
      "tts-ggml: the LavaSR enhancer/denoiser are not supported with " +
        "the moss engine. Drop lavasrEnhancer / lavasrDenoiser.",
    );
  }
  assertMossOutputRate(setup);
  assertMossVoiceConsistent(setup);
  assertMossDurationTokens(setup.settings.durationTokens, "constructor");
  assertMossDialogueReferences(setup);
}

function assertNoMossOnlyOptions(setup: EngineSetup): void {
  const mossOnly = setOptionNames({
    durationTokens: setup.settings.durationTokens,
    dialogueReferences: setup.settings.dialogueReferences !== undefined || undefined,
  });
  if (mossOnly.length === 0) return;
  throw new Error(
    `tts-ggml: ${mossOnly.join(", ")} are moss-only options ` +
      `(engine is ${setup.engineType})`,
  );
}

function assertMossDialogueReferences(setup: EngineSetup): void {
  if (setup.settings.dialogueReferences === undefined) return;
  assertDialogueReferenceList(setup.settings.dialogueReferences);
  if (setup.settings.referenceAudio) {
    throw new Error(
      "tts-ggml: referenceAudio and dialogueReferences are exclusive; " +
        "pass one recording per speaker in dialogueReferences",
    );
  }
  if (!setup.paths.mossCodecEncoderPath) {
    throw new Error(
      "tts-ggml: dialogue synthesis with the moss engine needs the codec " +
        "encoder GGUF (files.mossCodecEncoder)",
    );
  }
  if (!setup.paths.mossBackbonePath) {
    throw new Error(
      "tts-ggml: dialogue synthesis with the moss engine needs the MOSS-TTSD " +
        "backbone: stage moss-ttsd-*.gguf in modelDir or set files.mossBackbone",
    );
  }
}

export function assertMossOutputRate(setup: EngineSetup): void {
  if (
    setup.outputSampleRate == null ||
    setup.outputSampleRate === MOSS_NATIVE_SAMPLE_RATE
  ) {
    return;
  }
  throw new Error(
    `tts-ggml: the moss engine emits ${MOSS_NATIVE_SAMPLE_RATE} Hz only; ` +
      `drop outputSampleRate (got ${setup.outputSampleRate}).`,
  );
}

function assertMossVoiceConsistent(setup: EngineSetup): void {
  if (!setup.settings.referenceAudio || setup.paths.mossCodecEncoderPath) return;
  throw new Error(
    "tts-ggml: voice cloning with the moss engine needs the codec " +
      "encoder GGUF (files.mossCodecEncoder)",
  );
}

export function buildMossParams(
  setup: EngineSetup,
): TTSConfigurationParams {
  assertMossOutputRate(setup);
  const parameters: TTSConfigurationParams = {
    engineType: ENGINE_MOSS,
    mossBackbonePath: setup.paths.mossBackbonePath || "",
    mossCodecDecoderPath: setup.paths.mossCodecDecoderPath || "",
    language: setup.config.language || "en",
  };
  if (setup.paths.mossCodecEncoderPath) {
    parameters.mossCodecEncoderPath = setup.paths.mossCodecEncoderPath;
  }
  if (setup.settings.referenceAudio != null) {
    parameters.referenceAudio = setup.settings.referenceAudio;
  }
  if (setup.settings.dialogueReferences) {
    parameters.dialogueReferences = [...setup.settings.dialogueReferences];
  }
  if (setup.settings.durationTokens != null) {
    parameters.durationTokens = setup.settings.durationTokens | 0;
  }
  if (setup.settings.streamChunkTokens != null) {
    parameters.streamChunkTokens = setup.settings.streamChunkTokens | 0;
  }
  assignBackendParams(setup, parameters);
  return parameters;
}

export function assertMossReloadKeepsVoice(
  setup: EngineSetup,
  newConfig: Record<string, unknown>,
): void {
  if (setup.engineType !== ENGINE_MOSS) return;
  const voiceKeys = MOSS_INSTANCE_VOICE_KEYS.filter(
    (key) => newConfig[key] !== undefined,
  );
  if (voiceKeys.length === 0) return;
  throw new Error(
    `tts-ggml: reload: the moss engine encodes ${voiceKeys.join(", ")} ` +
      "once per instance; create a new instance to clone different recordings",
  );
}

export function applyMossReload(
  setup: EngineSetup,
  newConfig: Record<string, unknown>,
): void {
  if (setup.engineType !== ENGINE_MOSS) return;
  const durationTokens = (newConfig as { durationTokens?: number | null })
    .durationTokens;
  if (durationTokens === undefined) return;
  assertMossDurationTokens(durationTokens, "reload");
  setup.settings.durationTokens = durationTokens ?? undefined;
}
