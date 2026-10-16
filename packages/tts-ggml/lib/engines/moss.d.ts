import type { TTSConfigurationParams } from "../../tts";
import type { EngineSetup, ModelPaths, SynthesisSettings } from "../engineSetup";
import { type NormalizedFiles } from "../modelFiles";
export declare const MOSS_BACKBONE_RE: RegExp;
export declare const MOSS_DIALOGUE_BACKBONE_RE: RegExp;
export declare const MOSS_DECODER_RE: RegExp;
export declare const MOSS_ENCODER_RE: RegExp;
export declare const MOSS_NATIVE_SAMPLE_RATE = 24000;
export declare const MOSS_FRAMES_PER_SECOND = 12.5;
export declare const MOSS_MAX_NEW_TOKENS = 2048;
export declare const MOSS_MAX_CHANNELS = 32;
export declare const MOSS_TERMINATION_ROWS = 2;
export declare const MOSS_MAX_DURATION_TOKENS: number;
export declare const MOSS_INSTANCE_VOICE_KEYS: readonly ["referenceAudio", "dialogueReferences"];
export declare function assertMossDurationTokens(value: number | null | undefined, where: string): void;
export declare function resolveMossModelPaths(files: NormalizedFiles, dialogue: boolean): Pick<ModelPaths, "mossBackbonePath" | "mossCodecDecoderPath" | "mossCodecEncoderPath">;
/** The MOSS voice and length options, read before model paths are resolved. */
export declare function mossVoiceSettings(options: {
    dialogueReferences?: string[];
    durationTokens?: number;
}): Pick<SynthesisSettings, "dialogueReferences" | "durationTokens">;
export declare function assertMossOptions(setup: EngineSetup): void;
export declare function assertMossOutputRate(setup: EngineSetup): void;
export declare function buildMossParams(setup: EngineSetup): TTSConfigurationParams;
export declare function assertMossReloadKeepsVoice(setup: EngineSetup, newConfig: Record<string, unknown>): void;
export declare function applyMossReload(setup: EngineSetup, newConfig: Record<string, unknown>): void;
