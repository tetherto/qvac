/**
 * Engine discovery: which engine a `files` object selects, and the model paths
 * that engine loads. Precedence: an explicit `engine` option, then explicit
 * per-engine file keys, then the contents of a shared `modelDir`.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS export shapes. */
import path = require("bare-path");
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  ENGINE_AUDIO8,
  ENGINE_CHATTERBOX,
  ENGINE_COSYVOICE3,
  ENGINE_MOSS,
  ENGINE_MOSS_SFX,
  ENGINE_MOSS_SPEECH,
  ENGINE_PARLER,
  ENGINE_POCKET,
  ENGINE_SUPERTONIC,
  isEngineType,
  type EngineType,
} from "./engineIds";
import type { ModelPaths } from "./engineSetup";
import { AUDIO8_LM_RE, resolveAudio8ModelPaths } from "./engines/audio8";
import {
  hasChatterboxModelDir,
  resolveChatterboxModelPaths,
} from "./engines/chatterbox";
import {
  dirHasCosyvoice3,
  resolveCosyvoiceModelPaths,
} from "./engines/cosyvoice";
import {
  MOSS_BACKBONE_RE,
  MOSS_DIALOGUE_BACKBONE_RE,
  resolveMossModelPaths,
} from "./engines/moss";
import {
  MOSS_SFX_RE,
  resolveMossSoundEffectModelPaths,
} from "./engines/mossSoundEffect";
import {
  MOSS_SPEECH_RE,
  resolveMossSpeechModelPaths,
} from "./engines/mossSpeech";
import { findParlerInDir, resolveParlerModelPaths } from "./engines/parler";
import {
  hasSupertonicModelDir,
  resolveSupertonicModelPaths,
} from "./engines/supertonic";
import {
  fileExistsSafe,
  findQuantRankedGguf,
  firstNonEmpty,
  type NormalizedFiles,
} from "./modelFiles";

const POCKET_FLOW_LM = "flow-lm.gguf";

export function detectEngineType(
  engine: EngineType | undefined,
  files: NormalizedFiles,
): EngineType {
  if (isEngineType(engine)) return engine;
  if (engine != null && engine !== "") {
    throw new Error(
      "tts-ggml: 'engine' option must be 'chatterbox', 'supertonic', " +
        `'cosyvoice3', 'parler', 'audio8', 'moss', 'moss-sfx', 'moss-speech' or 'pocket' (got '${String(engine)}')`,
    );
  }
  return (
    engineFromExplicitFiles(files) ??
    (files.modelDir ? engineFromModelDir(files.modelDir) : undefined) ??
    ENGINE_CHATTERBOX
  );
}

/** Explicit per-engine file keys, in precedence order. */
function engineFromExplicitFiles(files: NormalizedFiles): EngineType | undefined {
  if (files.pocketFlowModel || files.pocketMimiModel) return ENGINE_POCKET;
  // Explicit CosyVoice3 files/dir take precedence over shared-modelDir sniffing.
  if (files.cosyvoiceModelDir || files.cosyvoiceLlmModel) {
    return ENGINE_COSYVOICE3;
  }
  if (files.t3Model || files.s3genModel) return ENGINE_CHATTERBOX;
  if (files.supertonicModel) return ENGINE_SUPERTONIC;
  if (files.parlerModel) return ENGINE_PARLER;
  if (files.audio8Lm || files.audio8CodecDecoder) return ENGINE_AUDIO8;
  if (files.mossBackbone || files.mossCodecDecoder) return ENGINE_MOSS;
  if (files.mossSoundEffect) return ENGINE_MOSS_SFX;
  if (files.mossSpeechModel || files.mossSpeechCodec) return ENGINE_MOSS_SPEECH;
  return undefined;
}

/** What a shared `modelDir` holds, in precedence order. */
function engineFromModelDir(modelDir: string): EngineType | undefined {
  if (dirHasCosyvoice3(modelDir)) return ENGINE_COSYVOICE3;
  if (hasChatterboxModelDir(modelDir)) return ENGINE_CHATTERBOX;
  if (hasSupertonicModelDir(modelDir)) return ENGINE_SUPERTONIC;
  if (findParlerInDir(modelDir)) return ENGINE_PARLER;
  if (findQuantRankedGguf(modelDir, AUDIO8_LM_RE)) return ENGINE_AUDIO8;
  if (findQuantRankedGguf(modelDir, MOSS_BACKBONE_RE)) return ENGINE_MOSS;
  if (findQuantRankedGguf(modelDir, MOSS_DIALOGUE_BACKBONE_RE)) return ENGINE_MOSS;
  if (findQuantRankedGguf(modelDir, MOSS_SFX_RE)) return ENGINE_MOSS_SFX;
  if (findQuantRankedGguf(modelDir, MOSS_SPEECH_RE)) return ENGINE_MOSS_SPEECH;
  if (fileExistsSafe(path.join(modelDir, POCKET_FLOW_LM))) return ENGINE_POCKET;
  return undefined;
}

/** The constructor options that name dictionary files directly. */
export interface ModelPathOptions {
  mecabDictPath?: string;
  mecabDictDir?: string;
  cangjieTsvPath?: string;
  /** MOSS dialogue mode, which narrows the backbone discovered under `modelDir`. */
  dialogue: boolean;
}

/** The model files `engineType` loads: explicit paths first, then `modelDir`. */
export function resolveModelPaths(
  engineType: EngineType,
  files: NormalizedFiles,
  options: ModelPathOptions,
): ModelPaths {
  const shared: ModelPaths = {
    voicesDir: files.voicesDir,
    mecabDictPath: firstNonEmpty(
      options.mecabDictPath,
      options.mecabDictDir,
      files.mecabDictDir,
    ),
    cangjieTsvPath: firstNonEmpty(options.cangjieTsvPath, files.cangjieTsvPath),
  };
  switch (engineType) {
    case ENGINE_POCKET:
      return shared;
    case ENGINE_COSYVOICE3:
      return { ...shared, ...resolveCosyvoiceModelPaths(files) };
    case ENGINE_SUPERTONIC:
      return { ...shared, ...resolveSupertonicModelPaths(files) };
    case ENGINE_PARLER:
      return { ...shared, ...resolveParlerModelPaths(files) };
    case ENGINE_AUDIO8:
      return { ...shared, ...resolveAudio8ModelPaths(files) };
    case ENGINE_MOSS:
      return { ...shared, ...resolveMossModelPaths(files, options.dialogue) };
    case ENGINE_MOSS_SFX:
      return { ...shared, ...resolveMossSoundEffectModelPaths(files) };
    case ENGINE_MOSS_SPEECH:
      return { ...shared, ...resolveMossSpeechModelPaths(files) };
    default:
      return { ...shared, ...resolveChatterboxModelPaths(files) };
  }
}
