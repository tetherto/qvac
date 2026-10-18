/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS export shapes. */
import fs = require("bare-fs");
import path = require("bare-path");
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Model file paths for the GGML TTS backend. Engine is auto-detected
 * from these fields (Chatterbox vs Supertonic) unless overridden via
 * `TTSGgmlOptions.engine`. All paths must be absolute and are passed
 * through to the native layer as-is.
 */
export interface TTSGgmlFiles {
  pocketFlowModel?: string;
  pocketMimiModel?: string;
  pocketFrontend?: string;
  pocketVoice?: string;
  /**
   * Bundle root. For Chatterbox, expected to contain
   * `chatterbox-t3-turbo.gguf` + `chatterbox-s3gen.gguf` (turbo) or
   * `chatterbox-t3-mtl.gguf` + `chatterbox-s3gen-mtl.gguf` (multilingual).
   * For Supertonic, expected to contain `supertonic.gguf`.
   */
  modelDir?: string;
  /** Chatterbox T3 (text to speech tokens) GGUF path. Overrides `modelDir`. */
  t3Model?: string;
  t3ModelPath?: string;
  t3?: string;
  /** Chatterbox S3Gen + HiFT (speech tokens to 24 kHz wav) GGUF path. Overrides `modelDir`. */
  s3genModel?: string;
  s3genModelPath?: string;
  s3gen?: string;
  /** Supertonic single-file GGUF path. Overrides `modelDir`. */
  supertonicModel?: string;
  supertonicModelPath?: string;
  supertonic?: string;
  /** Parler single-file GGUF path (mini/large/indic). Overrides `modelDir`. */
  parlerModel?: string;
  parlerModelPath?: string;
  parler?: string;
  /** Audio8 DualAR language model GGUF path. Overrides `modelDir`. */
  audio8Lm?: string;
  audio8LmPath?: string;
  /** Audio8 codec synthesis half (codes to 44.1 kHz wav). Overrides `modelDir`. */
  audio8CodecDecoder?: string;
  audio8CodecDecoderPath?: string;
  /**
   * Audio8 codec analysis half (wav to codes). Only needed to clone a voice
   * from a recording; a text-only deployment can leave it out.
   */
  audio8CodecEncoder?: string;
  audio8CodecEncoderPath?: string;
  /**
   * MOSS Delay backbone GGUF path: MOSS-TTS (`moss-tts-delay-*.gguf`) or the
   * MOSS-TTSD dialogue checkpoint (`moss-ttsd-*.gguf`). Overrides `modelDir`.
   */
  mossBackbone?: string;
  mossBackbonePath?: string;
  /** MOSS codec synthesis half (codes to 24 kHz wav). Overrides `modelDir`. */
  mossCodecDecoder?: string;
  mossCodecDecoderPath?: string;
  /**
   * MOSS codec analysis half (wav to codes). Only needed to clone a voice
   * from `referenceAudio` or for `dialogueReferences`; a text-only deployment
   * can leave it out.
   */
  mossCodecEncoder?: string;
  mossCodecEncoderPath?: string;
  /**
   * MOSS-SoundEffect GGUF (`moss-sfx-*.gguf`): text encoder, DiT and VAE in
   * one file. Routes to the `moss-sfx` engine. Overrides `modelDir`.
   */
  mossSoundEffect?: string;
  mossSoundEffectPath?: string;
  /**
   * MOSS-Speech language model GGUF (`moss-speech-*.gguf`, e.g.
   * `moss-speech-q8_0.gguf`). Routes to the `moss-speech` engine together
   * with `mossSpeechCodec`. Overrides `modelDir`.
   */
  mossSpeechModel?: string;
  mossSpeechModelPath?: string;
  /**
   * MOSS-Speech codec GGUF (`moss-speech-codec-*.gguf`): speech tokenizer,
   * reply decoder and the default reply voice. Overrides `modelDir`.
   */
  mossSpeechCodec?: string;
  mossSpeechCodecPath?: string;
  /**
   * CosyVoice3 model directory holding the sub-model GGUFs
   * (`cosyvoice3-{llm,flow,hift}-*.gguf`) plus `voice.gguf`, `vocab.json` and
   * `merges.txt`. Routes to the CosyVoice3 engine. Falls back to the shared
   * `modelDir` when unset.
   */
  cosyvoiceModelDir?: string;
  /** CosyVoice3 per-component GGUF paths (override discovery under the model dir). */
  cosyvoiceLlmModel?: string;
  cosyvoiceLlmModelPath?: string;
  cosyvoiceFlowModel?: string;
  cosyvoiceFlowModelPath?: string;
  cosyvoiceHiftModel?: string;
  cosyvoiceHiftModelPath?: string;
  /**
   * CosyVoice3 voice-cloning add-on GGUFs, required only when
   * `referenceAudio` is set: the speech_tokenizer_v3 speech tokenizer
   * (`cosyvoice3-s3tok-*.gguf`) and the CAM++ speaker encoder
   * (`cosyvoice3-campplus-*.gguf`). Auto-discovered under
   * `cosyvoiceModelDir` by those name prefixes when unset.
   */
  cosyvoiceS3tokModel?: string;
  cosyvoiceS3tokModelPath?: string;
  cosyvoiceCampplusModel?: string;
  cosyvoiceCampplusModelPath?: string;
  /**
   * CosyVoice3 Qwen2 BPE text frontend (`vocab.json` + `merges.txt`) and the
   * baked default-voice GGUF (`voice.gguf`). Each is resolved under the model
   * dir when unset; `cosyvoiceVoiceModel` is how a different baked voice is
   * selected without a separate model directory.
   */
  cosyvoiceVocab?: string;
  cosyvoiceVocabPath?: string;
  cosyvoiceMerges?: string;
  cosyvoiceMergesPath?: string;
  cosyvoiceVoiceModel?: string;
  cosyvoiceVoiceModelPath?: string;
  /**
   * LavaSR enhancer GGUF: single-file Vocos bandwidth extension produced by
   * tts-cpp/scripts/convert-lavasr-enhancer-to-gguf.py. When supplied, output
   * is neurally upsampled to 48 kHz (the canonical way to enable enhancement;
   * `enhancer.enhancerPath` is the only alternative).
   */
  lavasrEnhancer?: string;
  /**
   * LavaSR denoiser GGUF: UL-UNAS speech denoiser produced by
   * tts-cpp/scripts/convert-lavasr-denoiser-to-gguf.py. Runs before the
   * enhancer and is rate-preserving (the canonical way to enable denoising;
   * `denoiser.denoiserPath` is the only alternative).
   *
   * The tts-cpp UL-UNAS forward is implemented in qvac-fabric-speech.cpp
   * PR #78 (scalar CPU port, validated bit-close to the ONNX reference).
   */
  lavasrDenoiser?: string;
  /** Optional directory containing baked Chatterbox voice profiles. */
  voicesDir?: string;
  /**
   * Chatterbox MTL only: directory holding the compiled MeCab/IPAdic
   * dictionary used for Japanese morphological segmentation. Forwarded to
   * tts-cpp's `EngineOptions::mecab_dict_path`. Alias: top-level
   * `mecabDictPath`.
   */
  mecabDictDir?: string;
  mecabDictPath?: string;
  /**
   * Chatterbox MTL only: path to the Cangjie TSV used for Chinese
   * romanisation. Forwarded to tts-cpp's `EngineOptions::cangjie_tsv_path`.
   */
  cangjieTsvPath?: string;
  cangjieTsv?: string;
}

/** `TTSGgmlFiles` with every alias collapsed onto one canonical key. */
export interface NormalizedFiles {
  pocketFlowModel?: string;
  pocketMimiModel?: string;
  pocketFrontend?: string;
  pocketVoice?: string;
  modelDir?: string;
  t3Model?: string;
  s3genModel?: string;
  supertonicModel?: string;
  cosyvoiceModelDir?: string;
  cosyvoiceLlmModel?: string;
  cosyvoiceFlowModel?: string;
  cosyvoiceHiftModel?: string;
  cosyvoiceS3tokModel?: string;
  cosyvoiceCampplusModel?: string;
  cosyvoiceVocab?: string;
  cosyvoiceMerges?: string;
  cosyvoiceVoiceModel?: string;
  parlerModel?: string;
  audio8Lm?: string;
  audio8CodecDecoder?: string;
  audio8CodecEncoder?: string;
  mossBackbone?: string;
  mossCodecDecoder?: string;
  mossCodecEncoder?: string;
  mossSoundEffect?: string;
  mossSpeechModel?: string;
  mossSpeechCodec?: string;
  voicesDir?: string;
  lavasrEnhancer?: string;
  lavasrDenoiser?: string;
  mecabDictDir?: string;
  cangjieTsvPath?: string;
}

export function firstNonEmpty<T>(
  ...candidates: Array<T | "" | null | undefined>
): T | undefined {
  for (const value of candidates) {
    if (value != null && value !== "") return value;
  }
  return undefined;
}

export function fileExistsSafe(filePath?: string): boolean {
  if (!filePath) return false;
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

/**
 * Preferred quant tier when a model directory holds several copies of the same
 * GGUF (Audio8 and MOSS): the tier that reads best for its size.
 */
const QUANT_TIER_ORDER = ["q8_0", "f16", "q4_0", "f32"];

export function readDirSafe(modelDir?: string): string[] {
  if (!modelDir) return [];
  try {
    return fs.readdirSync(modelDir);
  } catch {
    return [];
  }
}

export function ggufQuantRank(name: string, pattern: RegExp): number {
  const match = name.match(pattern);
  if (!match) return Number.MAX_SAFE_INTEGER;
  if (!match[1]) return 0;
  const index = QUANT_TIER_ORDER.indexOf(match[1].slice(1).toLowerCase());
  return index === -1 ? QUANT_TIER_ORDER.length + 1 : index + 1;
}

/**
 * Find one Audio8 or MOSS GGUF in `modelDir`, preferring the quant tier that
 * reads best for its size (q8_0 > f16 > q4_0 > f32).
 */
export function findQuantRankedGguf(
  modelDir: string | undefined,
  pattern: RegExp,
): string | undefined {
  if (!modelDir) return undefined;
  const matches = readDirSafe(modelDir).filter((name) => pattern.test(name));
  if (matches.length === 0) return undefined;
  matches.sort(
    (left, right) =>
      ggufQuantRank(left, pattern) - ggufQuantRank(right, pattern),
  );
  return path.join(modelDir, matches[0]);
}

type FileKey = keyof TTSGgmlFiles;
type CanonicalFileKey = keyof NormalizedFiles;

/**
 * Alias table behind `normalizeGgmlFiles`: one row per `NormalizedFiles` key,
 * the canonical key first and then its aliases in precedence order. The first
 * non-empty value in a row wins, so the canonical key beats every alias and an
 * earlier alias beats a later one.
 */
export const FILE_ALIAS_TABLE: ReadonlyArray<
  readonly [CanonicalFileKey, ...FileKey[]]
> = [
  ["modelDir"],
  ["pocketFlowModel"],
  ["pocketMimiModel"],
  ["pocketFrontend"],
  ["pocketVoice"],
  ["t3Model", "t3ModelPath", "t3"],
  ["s3genModel", "s3genModelPath", "s3gen"],
  ["supertonicModel", "supertonicModelPath", "supertonic"],
  // CosyVoice3: either a dedicated modelDir of cosyvoice3-*.gguf files, or
  // explicit per-component paths. Falls back to the shared `modelDir`.
  ["cosyvoiceModelDir"],
  ["cosyvoiceLlmModel", "cosyvoiceLlmModelPath"],
  ["cosyvoiceFlowModel", "cosyvoiceFlowModelPath"],
  ["cosyvoiceHiftModel", "cosyvoiceHiftModelPath"],
  ["cosyvoiceS3tokModel", "cosyvoiceS3tokModelPath"],
  ["cosyvoiceCampplusModel", "cosyvoiceCampplusModelPath"],
  ["cosyvoiceVocab", "cosyvoiceVocabPath"],
  ["cosyvoiceMerges", "cosyvoiceMergesPath"],
  ["cosyvoiceVoiceModel", "cosyvoiceVoiceModelPath"],
  ["parlerModel", "parlerModelPath", "parler"],
  ["audio8Lm", "audio8LmPath"],
  ["audio8CodecDecoder", "audio8CodecDecoderPath"],
  ["audio8CodecEncoder", "audio8CodecEncoderPath"],
  ["mossBackbone", "mossBackbonePath"],
  ["mossCodecDecoder", "mossCodecDecoderPath"],
  ["mossCodecEncoder", "mossCodecEncoderPath"],
  ["mossSoundEffect", "mossSoundEffectPath"],
  ["mossSpeechModel", "mossSpeechModelPath"],
  ["mossSpeechCodec", "mossSpeechCodecPath"],
  ["voicesDir"],
  ["lavasrEnhancer"],
  ["lavasrDenoiser"],
  ["mecabDictDir", "mecabDictPath"],
  ["cangjieTsvPath", "cangjieTsv"],
];

export function normalizeGgmlFiles(
  files: TTSGgmlFiles | null | undefined,
): NormalizedFiles {
  if (files == null || typeof files !== "object") return {};
  const normalized: NormalizedFiles = {};
  for (const row of FILE_ALIAS_TABLE) {
    normalized[row[0]] = firstNonEmpty(...row.map((key) => files[key]));
  }
  return normalized;
}
