/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS export shapes. */
import fs = require("bare-fs");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { TTSConfigurationParams } from "../../tts";
import { ENGINE_COSYVOICE3 } from "../engineIds";
import type { EngineSetup, ModelPaths } from "../engineSetup";
import { firstNonEmpty, type NormalizedFiles } from "../modelFiles";
import { assignCommonNativeParams } from "../nativeParams";

// The LLM sub-model is the tell for CosyVoice3 modelDir auto-detection.
export const COSYVOICE3_LLM_RE = /^cosyvoice3-llm(-[a-z0-9_]+)?\.gguf$/i;

// CosyVoice3 instruct2 control vocabulary (cosyvoice/utils/common.py
// instruct_list). The structured `instruct` option renders to the exact
// trained instruction string; the native engine wraps it as
// "You are a helpful assistant. " + <instruction> + "<|endofprompt|>" and
// drops the LM prompt speech tokens. One control applies per synthesis
// (the model is trained on single instructions).
export const COSYVOICE_DIALECTS = {
  cantonese: "广东话",
  northeastern: "东北话",
  gansu: "甘肃话",
  guizhou: "贵州话",
  henan: "河南话",
  hubei: "湖北话",
  hunan: "湖南话",
  jiangxi: "江西话",
  minnan: "闽南话",
  ningxia: "宁夏话",
  shanxi: "山西话",
  shaanxi: "陕西话",
  shandong: "山东话",
  shanghai: "上海话",
  sichuan: "四川话",
  tianjin: "天津话",
  yunnan: "云南话",
} as const;
export const COSYVOICE_VOLUMES = {
  loud: "Please say a sentence as loudly as possible.",
  soft: "Please say a sentence in a very soft voice.",
} as const;
export const COSYVOICE_STYLES = {
  peppa: "我想体验一下小猪佩奇风格，可以吗？",
  robot: "你可以尝试用机器人的方式解答吗？",
} as const;

/**
 * CosyVoice3 controls that have no canonical cross-engine vocabulary yet.
 * Emotion and speaking rate are NOT here -- use the top-level `emotion` /
 * `pace` options, which work the same way on every engine that supports them.
 * Exactly one field takes effect per synthesis, resolved by precedence
 * dialect > volume > style. Pass a raw string instead for an arbitrary
 * instruction (advanced escape hatch).
 */
export interface CosyvoiceInstruct {
  /** Chinese dialect; renders "请用{dialect}表达。". */
  dialect?: keyof typeof COSYVOICE_DIALECTS;
  /** Loudness. */
  volume?: keyof typeof COSYVOICE_VOLUMES;
  /** Playful style preset. */
  style?: keyof typeof COSYVOICE_STYLES;
}

/**
 * Look up a structured-instruct control value, throwing a clear error for an
 * invalid key instead of letting an `undefined` render into the instruction
 * string.
 */
function cosyvoiceInstructValue(
  map: Record<string, string>,
  key: string,
  kind: string,
): string {
  const value = map[key];
  if (value == null) {
    throw new Error(
      `Invalid CosyVoice instruct ${kind} "${key}". Valid ${kind}s: ${Object.keys(map).join(", ")}.`,
    );
  }
  return value;
}

/**
 * Render a CosyVoice3 `instruct` option to the trained instruction string.
 * A raw string passes through (trimmed); the structured form emits exactly one
 * control by precedence dialect > volume > style. Returns "" for no
 * instruction. An invalid structured key throws.
 */
export function renderCosyvoiceInstruct(
  instruct: string | CosyvoiceInstruct | undefined,
): string {
  // Only `undefined` means "omitted" (zero-shot). An explicit `null` is a
  // malformed value, not an omission, so it is rejected below like any other
  // non-object.
  if (instruct === undefined) return "";
  if (typeof instruct === "string") return instruct.trim();
  // A JS caller can pass values the type forbids (null, a number, an array, a
  // Date, a class instance). Check defensively as `unknown`: require an ordinary
  // object literal so exotic objects can't slip past the presence checks below
  // and degrade to zero-shot, and so control fields are read from the object's
  // own properties rather than an inherited prototype.
  const control = instruct as unknown;
  if (control === null || typeof control !== "object" || Array.isArray(control)) {
    throw new Error(
      "Invalid CosyVoice instruct: expected a string or a plain control " +
        "object such as { dialect: 'cantonese' }.",
    );
  }
  const proto = Object.getPrototypeOf(control) as object | null;
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(
      "Invalid CosyVoice instruct: expected a plain control object such as " +
        "{ dialect: 'cantonese' }, not an instance of another type.",
    );
  }
  // Reject unknown structured keys (typos like `{ dialekt: 'cantonese' }`)
  // before the precedence chain, which would otherwise fall through to "".
  const supportedControls = ["dialect", "volume", "style"];
  const unknownKeys = Object.keys(instruct).filter(
    (key) => !supportedControls.includes(key),
  );
  if (unknownKeys.length > 0) {
    const hint = unknownKeys.some((key) => key === "emotion" || key === "speed")
      ? " Emotion and speaking rate moved to the top-level `emotion` / `pace` options."
      : "";
    throw new Error(
      `Invalid CosyVoice instruct key(s): ${unknownKeys.join(", ")}. ` +
        `Valid keys: dialect, volume, style.${hint}`,
    );
  }
  // Presence, not truthiness: a control that is set to a malformed value
  // (`{ dialect: '' }`, `{ dialect: null }`) must raise via
  // cosyvoiceInstructValue rather than fall through to zero-shot. `undefined`
  // means the field was not set, so it is skipped. Precedence: dialect >
  // volume > style.
  if (instruct.dialect !== undefined) {
    return `请用${cosyvoiceInstructValue(COSYVOICE_DIALECTS, instruct.dialect, "dialect")}表达。`;
  }
  if (instruct.volume !== undefined) {
    return cosyvoiceInstructValue(COSYVOICE_VOLUMES, instruct.volume, "volume");
  }
  if (instruct.style !== undefined) {
    return cosyvoiceInstructValue(COSYVOICE_STYLES, instruct.style, "style");
  }
  return "";
}

/**
 * CosyVoice3 per-call instruction. Same values as the constructor's
 * `instruct`; a per-call conditioning control replaces the configured one for
 * that synthesis, and one control takes effect per synthesis.
 */
export interface CosyvoiceJobFields {
  instruct?: string | CosyvoiceInstruct;
}

/**
 * True when `modelDir` contains a CosyVoice3 LLM GGUF (the sub-model that
 * unambiguously identifies a CosyVoice3 model directory).
 */
export function dirHasCosyvoice3(modelDir?: string): boolean {
  if (!modelDir) return false;
  let entries: string[];
  try {
    entries = fs.readdirSync(modelDir);
  } catch {
    return false;
  }
  return entries.some((name) => COSYVOICE3_LLM_RE.test(name));
}

/**
 * CosyVoice3 discovers its sub-model GGUFs from a model directory; the native
 * engine resolves the individual components. Explicit per-component paths win
 * over the directory.
 */
export function resolveCosyvoiceModelPaths(
  files: NormalizedFiles,
): Pick<
  ModelPaths,
  | "cosyvoiceModelDir"
  | "cosyvoiceLlmModelPath"
  | "cosyvoiceFlowModelPath"
  | "cosyvoiceHiftModelPath"
  | "cosyvoiceS3tokModelPath"
  | "cosyvoiceCampplusModelPath"
  | "cosyvoiceVocabPath"
  | "cosyvoiceMergesPath"
  | "cosyvoiceVoiceModelPath"
> {
  return {
    cosyvoiceModelDir: firstNonEmpty(files.cosyvoiceModelDir, files.modelDir),
    cosyvoiceLlmModelPath: files.cosyvoiceLlmModel,
    cosyvoiceFlowModelPath: files.cosyvoiceFlowModel,
    cosyvoiceHiftModelPath: files.cosyvoiceHiftModel,
    cosyvoiceS3tokModelPath: files.cosyvoiceS3tokModel,
    cosyvoiceCampplusModelPath: files.cosyvoiceCampplusModel,
    cosyvoiceVocabPath: files.cosyvoiceVocab,
    cosyvoiceMergesPath: files.cosyvoiceMerges,
    cosyvoiceVoiceModelPath: files.cosyvoiceVoiceModel,
  };
}

export function assertCosyvoiceOptionConsistency(setup: EngineSetup): void {
  if (setup.engineType === ENGINE_COSYVOICE3) return;
  const cosyvoiceOnly: string[] = [];
  const cosyvoiceOnlyFields: Record<
    string,
    string | number | undefined
  > = {
    instruct: setup.settings.instruct,
    promptText: setup.settings.promptText,
  };
  for (const [key, value] of Object.entries(cosyvoiceOnlyFields)) {
    if (value != null) cosyvoiceOnly.push(key);
  }
  if (cosyvoiceOnly.length > 0) {
    throw new Error(
      `tts-ggml: ${cosyvoiceOnly.join(", ")} are cosyvoice3-only options ` +
        `(engine is ${setup.engineType})`,
    );
  }
}

/**
 * `promptText` is deliberately not required: its absence selects
 * cross-lingual mode. With a model dir present but no cloning GGUFs in it,
 * the native load fail-closes instead.
 */
export function assertCosyvoiceCloneConsistent(setup: EngineSetup): void {
  if (setup.engineType !== ENGINE_COSYVOICE3) return;
  if (!setup.settings.referenceAudio) return;
  const haveExplicit =
    setup.paths.cosyvoiceS3tokModelPath && setup.paths.cosyvoiceCampplusModelPath;
  if (!haveExplicit && !setup.paths.cosyvoiceModelDir) {
    throw new Error(
      "tts-ggml: referenceAudio (CosyVoice3 voice cloning) needs the " +
        "speech-tokenizer and speaker-encoder GGUFs: set " +
        "files.cosyvoiceS3tokModel + files.cosyvoiceCampplusModel, or a " +
        "files.cosyvoiceModelDir containing cosyvoice3-s3tok*.gguf and " +
        "cosyvoice3-campplus*.gguf",
    );
  }
}

/**
 * CosyVoice3's per-call instruction, rendered like the constructor's. The
 * native layer reads it next to emotion/pace, and any of the three replaces
 * the configured conditioning for that synthesis.
 */
export function resolveJobInstruct(
  setup: EngineSetup,
  source: CosyvoiceJobFields | null | undefined,
  where: string,
): string | undefined {
  if (source?.instruct === undefined) return undefined;
  if (setup.engineType !== ENGINE_COSYVOICE3) {
    throw new Error(
      `tts-ggml: ${where}: per-call instruct is cosyvoice3-only ` +
        `(engine is ${setup.engineType})`,
    );
  }
  return renderCosyvoiceInstruct(source.instruct) || undefined;
}

export function buildCosyvoiceParams(
  setup: EngineSetup,
): TTSConfigurationParams {
  const parameters: TTSConfigurationParams = {
    engineType: ENGINE_COSYVOICE3,
    cosyvoiceModelDir: setup.paths.cosyvoiceModelDir || "",
    language: setup.config.language || "en",
  };
  if (setup.paths.cosyvoiceLlmModelPath) {
    parameters.cosyvoiceLlmModelPath = setup.paths.cosyvoiceLlmModelPath;
  }
  if (setup.paths.cosyvoiceFlowModelPath) {
    parameters.cosyvoiceFlowModelPath = setup.paths.cosyvoiceFlowModelPath;
  }
  if (setup.paths.cosyvoiceHiftModelPath) {
    parameters.cosyvoiceHiftModelPath = setup.paths.cosyvoiceHiftModelPath;
  }
  if (setup.paths.cosyvoiceS3tokModelPath) {
    parameters.cosyvoiceS3tokModelPath = setup.paths.cosyvoiceS3tokModelPath;
  }
  if (setup.paths.cosyvoiceCampplusModelPath) {
    parameters.cosyvoiceCampplusModelPath = setup.paths.cosyvoiceCampplusModelPath;
  }
  if (setup.paths.cosyvoiceVocabPath) {
    parameters.cosyvoiceVocabPath = setup.paths.cosyvoiceVocabPath;
  }
  if (setup.paths.cosyvoiceMergesPath) {
    parameters.cosyvoiceMergesPath = setup.paths.cosyvoiceMergesPath;
  }
  if (setup.paths.cosyvoiceVoiceModelPath) {
    parameters.cosyvoiceVoiceModelPath = setup.paths.cosyvoiceVoiceModelPath;
  }
  if (setup.settings.vulkanDevice != null) {
    parameters.vulkanDevice = setup.settings.vulkanDevice | 0;
  }
  if (setup.settings.flowCutPrompt != null) {
    parameters.flowCutPrompt = !!setup.settings.flowCutPrompt;
  }
  if (setup.settings.referenceAudio != null) {
    parameters.referenceAudio = setup.settings.referenceAudio;
  }
  if (setup.settings.promptText != null) {
    parameters.promptText = String(setup.settings.promptText);
  }
  if (setup.settings.instruct) parameters.instruct = setup.settings.instruct;
  // Canonical values; the native layer maps them to the trained instructions.
  if (setup.settings.emotion != null) parameters.emotion = String(setup.settings.emotion);
  if (setup.settings.pace != null) parameters.pace = String(setup.settings.pace);
  if (setup.settings.voice) parameters.voice = setup.settings.voice;
  assignCommonNativeParams(setup, parameters);
  if (setup.settings.cfmSteps != null) parameters.cfmSteps = setup.settings.cfmSteps | 0;
  if (setup.settings.streamChunkTokens != null) {
    parameters.streamChunkTokens = setup.settings.streamChunkTokens | 0;
  }
  if (setup.settings.streamFirstChunkTokens != null) {
    parameters.streamFirstChunkTokens = setup.settings.streamFirstChunkTokens | 0;
  }
  if (setup.settings.streamLeftContextTokens != null) {
    parameters.streamLeftContextTokens = setup.settings.streamLeftContextTokens | 0;
  }
  return parameters;
}
