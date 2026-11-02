import type { TTSConfigurationParams } from "../../tts";
import type { EngineSetup, ModelPaths } from "../engineSetup";
import { type NormalizedFiles } from "../modelFiles";
export declare const MOSS_SFX_RE: RegExp;
export declare const MOSS_SFX_NATIVE_SAMPLE_RATE = 48000;
export declare const MOSS_SFX_MAX_SECONDS = 30;
export declare const MOSS_SFX_MAX_STEPS = 1000;
export declare const MOSS_SFX_MAX_GUIDANCE = 50;
export declare const MOSS_SFX_MAX_SHIFT = 100;
export declare const MOSS_SFX_CALL_KEYS: readonly ["seconds", "negativePrompt", "steps", "guidance", "shift"];
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
export declare function assertSoundEffectFields(fields: MossSoundEffectFields): void;
/**
 * Collect the MOSS-SoundEffect generation controls present on `source`.
 * Returns undefined when none are set.
 */
export declare function pickSoundEffectFields(source: MossSoundEffectFields | null | undefined): MossSoundEffectFields | undefined;
export declare function resolveMossSoundEffectModelPaths(files: NormalizedFiles): Pick<ModelPaths, "mossSoundEffectPath">;
export declare function assertMossSoundEffectOptions(setup: EngineSetup): void;
/**
 * Extract + validate the per-call MOSS-SoundEffect controls from a run
 * input. Returns undefined when none are present.
 */
export declare function resolveSoundEffectJobFields(setup: EngineSetup, source: MossSoundEffectFields | null | undefined, where: string): MossSoundEffectFields | undefined;
export declare function buildMossSoundEffectParams(setup: EngineSetup): TTSConfigurationParams;
