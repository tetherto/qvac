import type { TTSConfigurationParams } from "../../tts";
import type { EngineSetup, ModelPaths } from "../engineSetup";
import { type NormalizedFiles } from "../modelFiles";
export declare const AUDIO8_LM_RE: RegExp;
export declare const AUDIO8_DECODER_RE: RegExp;
export declare const AUDIO8_ENCODER_RE: RegExp;
export declare const AUDIO8_VOICE_KEYS: readonly ["referenceAudio", "referenceText"];
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
export declare function pickAudio8VoiceFields(source: Audio8VoiceFields | null | undefined): Audio8VoiceFieldsResolved | undefined;
/**
 * Mirrors Audio8Model::validateSampling, which stays the source of truth.
 * Reload checks the merged knobs here because native only sees them when the
 * instance is rebuilt: without this the refused value is already on the JS
 * object by then, and the two would describe different samplers.
 */
export declare function assertAudio8SamplingValid(sampling: Audio8SamplingFields, where: string): void;
export declare function resolveAudio8ModelPaths(files: NormalizedFiles): Pick<ModelPaths, "audio8LmPath" | "audio8CodecDecoderPath" | "audio8CodecEncoderPath">;
/**
 * A recording without its transcript is accepted by the model but degrades
 * the clone silently, and a transcript alone has nothing to attach to, so
 * both halves have to arrive together.
 */
export declare function assertAudio8VoiceConsistent(voice: Audio8VoiceFields, codecEncoderPath: string | undefined, where: string): void;
export declare function assertAudio8Options(setup: EngineSetup): void;
/**
 * Extract + validate the per-call Audio8 voice fields from a run input or
 * streaming options. Returns undefined when none are present.
 */
export declare function resolveAudio8JobFields(setup: EngineSetup, source: Audio8VoiceFields | null | undefined, where: string): Audio8VoiceFieldsResolved | undefined;
export declare function buildAudio8Params(setup: EngineSetup): TTSConfigurationParams;
/**
 * Audio8 voice + sampling knobs are reloadable; they rebuild the engine's
 * sampler and speaker history. Both merges are checked before either is
 * written, so a rejected reload leaves the instance exactly as it was
 * rather than half-moved onto the configuration that was refused.
 */
export declare function applyAudio8Reload(setup: EngineSetup, newConfig: Record<string, unknown>): void;
