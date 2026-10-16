import type { TTSConfigurationParams } from "../../tts";
import type { EngineSetup, ModelPaths } from "../engineSetup";
import { type NormalizedFiles } from "../modelFiles";
export declare const MOSS_SPEECH_RE: RegExp;
export declare const MOSS_SPEECH_CODEC_RE: RegExp;
export declare const MOSS_SPEECH_NATIVE_SAMPLE_RATE = 24000;
export declare const MOSS_SPEECH_MIN_SAMPLE_RATE = 8000;
export declare const MOSS_SPEECH_MAX_SAMPLE_RATE = 192000;
export declare const MOSS_SPEECH_MAX_NEW_TOKENS = 4096;
export declare const MOSS_SPEECH_MAX_REPLY_SECONDS = 3600;
export declare const MOSS_SPEECH_MAX_TEMPERATURE = 10;
export declare const MOSS_SPEECH_MAX_TOP_P = 1;
export declare const MOSS_SPEECH_ROLES: readonly ["system", "user", "assistant"];
export declare const MOSS_SPEECH_ONLY_KEYS: readonly ["audio", "sampleRate", "messages", "systemPrompt", "replyVoice", "replyVoiceSampleRate", "textReply", "maxReplySeconds", "maxNewTokens"];
export declare const MOSS_SPEECH_CONTROL_KEYS: readonly ["textReply", "maxReplySeconds", "maxNewTokens", "greedy", "temperature", "topP", "topK"];
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
export declare function assertSpeechCall(fields: MossSpeechFields & {
    input?: string;
}, where: string): void;
/** Collect the fields only MOSS-Speech reads that are present on `source`; undefined when none are set. */
export declare function pickSpeechFields(source: MossSpeechFields | null | undefined): Partial<MossSpeechFields> | undefined;
export declare function resolveMossSpeechModelPaths(files: NormalizedFiles): Pick<ModelPaths, "mossSpeechModelPath" | "mossSpeechCodecPath">;
export declare function assertMossSpeechOptions(setup: EngineSetup): void;
/**
 * Validate the MOSS-Speech call and fold the new user turn (spoken `audio`
 * or text `input`) and `systemPrompt` into the native `messages` list.
 */
export declare function resolveSpeechJobFields(source: (MossSpeechFields & {
    input?: string;
}) | null | undefined, where: string): MossSpeechJobFields;
export declare function buildMossSpeechParams(setup: EngineSetup): TTSConfigurationParams;
