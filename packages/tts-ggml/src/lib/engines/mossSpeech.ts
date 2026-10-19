import type { TTSConfigurationParams } from "../../tts";
import { ENGINE_MOSS_SPEECH } from "../engineIds";
import type { EngineSetup, ModelPaths } from "../engineSetup";
import {
  findQuantRankedGguf,
  firstNonEmpty,
  type NormalizedFiles,
} from "../modelFiles";
import { assignBackendParams } from "../nativeParams";

export const MOSS_SPEECH_RE = /^moss-speech(-(?!codec)[a-z0-9_]+)?\.gguf$/i;
export const MOSS_SPEECH_CODEC_RE = /^moss-speech-codec(-[a-z0-9_]+)?\.gguf$/i;
export const MOSS_SPEECH_NATIVE_SAMPLE_RATE = 24000;
export const MOSS_SPEECH_MIN_SAMPLE_RATE = 8000;
export const MOSS_SPEECH_MAX_SAMPLE_RATE = 192000;
export const MOSS_SPEECH_MAX_NEW_TOKENS = 4096;
export const MOSS_SPEECH_MAX_REPLY_SECONDS = 3600;
export const MOSS_SPEECH_MAX_TEMPERATURE = 10;
export const MOSS_SPEECH_MAX_TOP_P = 1;
export const MOSS_SPEECH_ROLES = ["system", "user", "assistant"] as const;
export const MOSS_SPEECH_ONLY_KEYS = [
  "audio",
  "sampleRate",
  "messages",
  "systemPrompt",
  "replyVoice",
  "replyVoiceSampleRate",
  "textReply",
  "maxReplySeconds",
  "maxNewTokens",
] as const;
export const MOSS_SPEECH_CONTROL_KEYS = [
  "textReply",
  "maxReplySeconds",
  "maxNewTokens",
  "greedy",
  "temperature",
  "topP",
  "topK",
] as const;

/** Mono PCM accepted by the MOSS-Speech engine: 16-bit integers or floats in [-1, 1]. */
export type MossSpeechPcm = Int16Array | Float32Array;

/** One conversation turn for the MOSS-Speech engine: text or audio, never both. */
export interface MossSpeechMessage {
  role: (typeof MOSS_SPEECH_ROLES)[number];
  text?: string;
  audio?: MossSpeechPcm;
  /** Sample rate of `audio`, 8000..192000 Hz. */
  sampleRate?: number;
}

/**
 * MOSS-Speech per-call fields (moss-speech only). The user turn is `audio`
 * (with `sampleRate`) or the run `input` text; `messages` carries the earlier
 * conversation.
 */
export interface MossSpeechFields {
  /** The user's spoken turn, mono PCM. */
  audio?: MossSpeechPcm;
  /** Sample rate of `audio`, 8000..192000 Hz. */
  sampleRate?: number;
  /** Earlier turns, oldest first; the new user turn is appended after them. */
  messages?: MossSpeechMessage[];
  /** A system turn placed first; replaces the model's default system prompt. */
  systemPrompt?: string;
  /** Reply voice prompt (up to 60 s of mono PCM); the codec's default voice otherwise. */
  replyVoice?: MossSpeechPcm;
  /** Sample rate of `replyVoice`, 8000..192000 Hz. */
  replyVoiceSampleRate?: number;
  /** Reply with text only (no audio); the text comes back as `text`. */
  textReply?: boolean;
  /** Cut the spoken reply after this many seconds (0 = no cut). */
  maxReplySeconds?: number;
  /** Explicit bound on generated rows, 1..4096; omitted uses remaining model context. */
  maxNewTokens?: number;
  /** Greedy decoding instead of sampling. */
  greedy?: boolean;
  /** Sampling temperature, (0, 10] (default 0.7). */
  temperature?: number;
  /** Nucleus sampling, (0, 1] (default 0.95). */
  topP?: number;
  /** Top-k sampling, >= 0 (default 20). */
  topK?: number;
}

/** The MOSS-Speech fields sent to the native job, with the user turn folded into `messages`. */
export interface MossSpeechJobFields {
  messages?: MossSpeechMessage[];
  replyVoice?: MossSpeechPcm;
  replyVoiceSampleRate?: number;
  textReply?: boolean;
  maxReplySeconds?: number;
  maxNewTokens?: number;
  greedy?: boolean;
  temperature?: number;
  topP?: number;
  topK?: number;
}

function isSpeechPcm(value: unknown): value is MossSpeechPcm {
  return value instanceof Int16Array || value instanceof Float32Array;
}

function assertSpeechSampleRate(value: unknown, name: string, where: string): void {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MOSS_SPEECH_MIN_SAMPLE_RATE &&
    value <= MOSS_SPEECH_MAX_SAMPLE_RATE
  ) {
    return;
  }
  throw new Error(
    `tts-ggml: ${where}: moss-speech ${name} must be an integer in ` +
      `[${MOSS_SPEECH_MIN_SAMPLE_RATE}, ${MOSS_SPEECH_MAX_SAMPLE_RATE}] (got ${String(value)})`,
  );
}

function assertSpeechAudio(audio: unknown, rate: unknown, names: [string, string], where: string): void {
  if (!isSpeechPcm(audio) || audio.length === 0) {
    throw new Error(
      `tts-ggml: ${where}: moss-speech ${names[0]} must be a non-empty Int16Array or Float32Array`,
    );
  }
  assertSpeechSampleRate(rate, names[1], where);
}

function assertSpeechMessage(message: unknown, index: number, where: string): void {
  const label = `messages[${index}]`;
  if (message == null || typeof message !== "object") {
    throw new Error(`tts-ggml: ${where}: moss-speech ${label} must be an object`);
  }
  const turn = message as MossSpeechMessage;
  if (!MOSS_SPEECH_ROLES.includes(turn.role)) {
    throw new Error(
      `tts-ggml: ${where}: moss-speech ${label}.role must be one of ${MOSS_SPEECH_ROLES.join(", ")}`,
    );
  }
  const hasText = typeof turn.text === "string" && turn.text.length > 0;
  const hasAudio = turn.audio !== undefined;
  if (hasText === hasAudio) {
    throw new Error(`tts-ggml: ${where}: moss-speech ${label} carries exactly one of text or audio`);
  }
  if (hasAudio) {
    assertSpeechAudio(turn.audio, turn.sampleRate, [`${label}.audio`, `${label}.sampleRate`], where);
  }
}

function assertSpeechMessages(messages: unknown, where: string): void {
  if (messages === undefined) return;
  if (!Array.isArray(messages)) {
    throw new Error(`tts-ggml: ${where}: moss-speech messages must be an array`);
  }
  assertEachSpeechMessage(messages, where);
}

function assertEachSpeechMessage(messages: unknown[], where: string): void {
  messages.forEach((message, index) => assertSpeechMessage(message, index, where));
}

function assertSpeechUserTurn(fields: MossSpeechFields & { input?: string }, where: string): void {
  const hasText = typeof fields.input === "string" && fields.input.trim().length > 0;
  const hasAudio = fields.audio !== undefined;
  if (hasText && hasAudio) {
    throw new Error(`tts-ggml: ${where}: moss-speech takes the user turn as audio or input text, not both`);
  }
  if (hasAudio) {
    assertSpeechAudio(fields.audio, fields.sampleRate, ["audio", "sampleRate"], where);
    return;
  }
  if (!hasText) {
    throw new Error(`tts-ggml: ${where}: moss-speech needs the user turn as audio (with sampleRate) or input text`);
  }
}

function assertSpeechRange(
  name: string,
  value: unknown,
  accepts: (n: number) => boolean,
  range: string,
  where: string,
): void {
  if (value === undefined) return;
  if (typeof value === "number" && Number.isFinite(value) && accepts(value)) return;
  const got = typeof value === "number" ? String(value) : typeof value;
  throw new Error(`tts-ggml: ${where}: moss-speech ${name} must be ${range} (got ${got})`);
}

function assertSpeechControls(fields: MossSpeechFields, where: string): void {
  assertSpeechRange("maxReplySeconds", fields.maxReplySeconds,
    (n) => n >= 0 && n <= MOSS_SPEECH_MAX_REPLY_SECONDS, `in [0, ${MOSS_SPEECH_MAX_REPLY_SECONDS}]`, where);
  assertSpeechRange("maxNewTokens", fields.maxNewTokens,
    (n) => Number.isInteger(n) && n >= 1 && n <= MOSS_SPEECH_MAX_NEW_TOKENS,
    `an integer in [1, ${MOSS_SPEECH_MAX_NEW_TOKENS}]`, where);
  assertSpeechRange("temperature", fields.temperature,
    (n) => n > 0 && n <= MOSS_SPEECH_MAX_TEMPERATURE, `in (0, ${MOSS_SPEECH_MAX_TEMPERATURE}]`, where);
  assertSpeechRange("topP", fields.topP,
    (n) => n > 0 && n <= MOSS_SPEECH_MAX_TOP_P, `in (0, ${MOSS_SPEECH_MAX_TOP_P}]`, where);
  assertSpeechRange("topK", fields.topK, (n) => Number.isInteger(n) && n >= 0, "an integer >= 0", where);
  assertSpeechBooleans(fields, where);
  if (fields.systemPrompt !== undefined && typeof fields.systemPrompt !== "string") {
    throw new Error(`tts-ggml: ${where}: moss-speech systemPrompt must be a string`);
  }
}

function assertSpeechBooleans(fields: MossSpeechFields, where: string): void {
  for (const flag of ["textReply", "greedy"] as const) {
    if (fields[flag] !== undefined && typeof fields[flag] !== "boolean") {
      throw new Error(`tts-ggml: ${where}: moss-speech ${flag} must be a boolean`);
    }
  }
}

function assertSpeechRateHasAudio(audio: unknown, rate: unknown, names: [string, string], where: string): void {
  if (audio !== undefined || rate === undefined) return;
  throw new Error(`tts-ggml: ${where}: moss-speech ${names[1]} needs ${names[0]}`);
}

export function assertSpeechCall(fields: MossSpeechFields & { input?: string }, where: string): void {
  assertSpeechUserTurn(fields, where);
  assertSpeechRateHasAudio(fields.audio, fields.sampleRate, ["audio", "sampleRate"], where);
  assertSpeechRateHasAudio(fields.replyVoice, fields.replyVoiceSampleRate, ["replyVoice", "replyVoiceSampleRate"], where);
  assertSpeechMessages(fields.messages, where);
  if (fields.replyVoice !== undefined) {
    assertSpeechAudio(fields.replyVoice, fields.replyVoiceSampleRate, ["replyVoice", "replyVoiceSampleRate"], where);
  }
  assertSpeechControls(fields, where);
}

function speechUserTurn(fields: MossSpeechFields & { input?: string }): MossSpeechMessage {
  if (fields.audio !== undefined) {
    return { role: "user", audio: fields.audio, sampleRate: fields.sampleRate };
  }
  return { role: "user", text: fields.input };
}

function speechMessages(fields: MossSpeechFields & { input?: string }): MossSpeechMessage[] {
  const system: MossSpeechMessage[] =
    fields.systemPrompt ? [{ role: "system", text: fields.systemPrompt }] : [];
  return [...system, ...(fields.messages ?? []), speechUserTurn(fields)];
}

function speechReplyVoice(
  fields: MossSpeechFields,
): Pick<MossSpeechJobFields, "replyVoice" | "replyVoiceSampleRate"> {
  if (fields.replyVoice === undefined) return {};
  return { replyVoice: fields.replyVoice, replyVoiceSampleRate: fields.replyVoiceSampleRate };
}

function speechControls(fields: MossSpeechFields): MossSpeechJobFields {
  const present = MOSS_SPEECH_CONTROL_KEYS.filter((key) => fields[key] !== undefined);
  return Object.fromEntries(present.map((key) => [key, fields[key]]));
}

/** Collect the fields only MOSS-Speech reads that are present on `source`; undefined when none are set. */
export function pickSpeechFields(
  source: MossSpeechFields | null | undefined,
): Partial<MossSpeechFields> | undefined {
  if (source == null || typeof source !== "object") return undefined;
  const present = MOSS_SPEECH_ONLY_KEYS.filter((key) => source[key] !== undefined);
  if (present.length === 0) return undefined;
  return Object.fromEntries(present.map((key) => [key, source[key]]));
}

export function resolveMossSpeechModelPaths(
  files: NormalizedFiles,
): Pick<ModelPaths, "mossSpeechModelPath" | "mossSpeechCodecPath"> {
  return {
    mossSpeechModelPath: firstNonEmpty(
      files.mossSpeechModel,
      findQuantRankedGguf(files.modelDir, MOSS_SPEECH_RE),
    ),
    mossSpeechCodecPath: firstNonEmpty(
      files.mossSpeechCodec,
      findQuantRankedGguf(files.modelDir, MOSS_SPEECH_CODEC_RE),
    ),
  };
}

export function assertMossSpeechOptions(setup: EngineSetup): void {
  if (setup.engineType !== ENGINE_MOSS_SPEECH) return;
  if (setup.backend.enhancerGgufPath || setup.backend.denoiserGgufPath) {
    throw new Error(
      "tts-ggml: the LavaSR enhancer/denoiser are not supported with " +
        "the moss-speech engine. Drop lavasrEnhancer / lavasrDenoiser.",
    );
  }
  if (setup.settings.referenceAudio) {
    throw new Error(
      "tts-ggml: the moss-speech engine takes its reply voice per call " +
        "(run({ replyVoice, replyVoiceSampleRate })), not referenceAudio",
    );
  }
  assertMossSpeechOutputRate(setup);
  if (!setup.paths.mossSpeechModelPath || !setup.paths.mossSpeechCodecPath) {
    throw new Error(
      "tts-ggml: the moss-speech engine needs its model and codec GGUFs: " +
        "stage moss-speech-*.gguf and moss-speech-codec-*.gguf in modelDir " +
        "or set files.mossSpeechModel and files.mossSpeechCodec",
    );
  }
}

function assertMossSpeechOutputRate(setup: EngineSetup): void {
  if (
    setup.outputSampleRate == null ||
    setup.outputSampleRate === MOSS_SPEECH_NATIVE_SAMPLE_RATE
  ) {
    return;
  }
  throw new Error(
    `tts-ggml: the moss-speech engine outputs ${MOSS_SPEECH_NATIVE_SAMPLE_RATE} Hz ` +
      `audio and cannot resample (outputSampleRate=${setup.outputSampleRate})`,
  );
}

/**
 * Validate the MOSS-Speech call and fold the new user turn (spoken `audio`
 * or text `input`) and `systemPrompt` into the native `messages` list.
 */
export function resolveSpeechJobFields(
  source: (MossSpeechFields & { input?: string }) | null | undefined,
  where: string,
): MossSpeechJobFields {
  const fields = source ?? {};
  assertSpeechCall(fields, where);
  return {
    messages: speechMessages(fields),
    ...speechReplyVoice(fields),
    ...speechControls(fields),
  };
}

export function buildMossSpeechParams(
  setup: EngineSetup,
): TTSConfigurationParams {
  assertMossSpeechOutputRate(setup);
  const parameters: TTSConfigurationParams = {
    engineType: ENGINE_MOSS_SPEECH,
    mossSpeechModelPath: setup.paths.mossSpeechModelPath || "",
    mossSpeechCodecPath: setup.paths.mossSpeechCodecPath || "",
  };
  assignBackendParams(setup, parameters);
  return parameters;
}
