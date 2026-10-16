import type { TTSConfigurationParams } from "../../tts";
import { type TTSConditioningFields } from "../conditioning";
import type { EngineSetup, ModelPaths } from "../engineSetup";
import { type NormalizedFiles } from "../modelFiles";
export declare const PARLER_RE: RegExp;
export declare const PARLER_VARIANT_ORDER: string[];
export declare const PARLER_QUANT_ORDER: string[];
export declare const PARLER_DESCRIPTION_KEYS: readonly ["description", "voiceDescription"];
export declare const PARLER_TEMPLATE_KEYS: readonly ["voice", "emotion", "pitch", "pace", "expressivity", "noise", "reverb", "quality"];
export declare const PARLER_ONLY_TEMPLATE_KEYS: readonly ["voice", "pitch", "expressivity", "noise", "reverb", "quality"];
export declare const PARLER_FIELD_KEYS: readonly ["description", "voiceDescription", "voice", "emotion", "pitch", "pace", "expressivity", "noise", "reverb", "quality"];
export declare const PARLER_ONLY_KEYS: readonly ["description", "voiceDescription", "voice", "pitch", "expressivity", "noise", "reverb", "quality"];
export type ParlerFieldKey = (typeof PARLER_FIELD_KEYS)[number];
export type ParlerDescFields = Partial<Record<ParlerFieldKey, string>>;
export type ParlerJobSource = ParlerDescriptionFields & TTSConditioningFields;
/**
 * Parler voice-description inputs. Either a free-text `description` (alias
 * `voiceDescription`) or the template fields, rendered natively through
 * tts-cpp's build_description(); mixing the two at the same level is rejected.
 * Accepted at construction, on `reload()`, and per call (Parler only).
 * `emotion` and `pace` moved to TTSConditioningFields -- Parler still renders
 * both, but they are no longer Parler-only at the JS surface.
 */
export interface ParlerDescriptionFields {
    description?: string;
    voiceDescription?: string;
    /** Parler voice-template field; also Supertonic's baked voice id. */
    voice?: string;
    pitch?: string;
    expressivity?: string;
    noise?: string;
    reverb?: string;
    quality?: string;
}
/**
 * Find a Parler GGUF in `modelDir`, ranked by variant (mini before large
 * before indic) and, within a variant, by quant tier (q8_0 > q6_k > f16 > f32;
 * a bare `parler-<variant>.gguf` wins as forward-compat).
 */
export declare function findParlerInDir(modelDir?: string): string | undefined;
/**
 * Collect the Parler description/template properties present on `source`
 * (a run input, streaming options, or constructor options). Returns undefined
 * when none are set.
 */
export declare function pickParlerDescFields(source: ParlerJobSource | null | undefined): ParlerDescFields | undefined;
/**
 * Same-level conflict check: a free-text description cannot be merged with
 * template fields, so setting both together is an error.
 */
export declare function assertParlerDescFieldsConsistent(fields: ParlerDescFields | undefined, where: string): void;
export declare function resolveParlerModelPaths(files: NormalizedFiles): Pick<ModelPaths, "parlerModelPath">;
/**
 * Constructor-time rules: on Parler the description and template fields are
 * mutually exclusive; on every other engine the Parler-only options are
 * rejected by name.
 */
export declare function assertParlerOptions(setup: EngineSetup): void;
/**
 * Parler's per-call surface: description/template fields, where a per-call
 * template cannot be merged with a constructor-level free-text description.
 */
export declare function resolveParlerJobFields(setup: EngineSetup, source: ParlerJobSource | null | undefined, where: string): ParlerDescFields | undefined;
export declare function buildParlerParams(setup: EngineSetup): TTSConfigurationParams;
/**
 * Parler description/template + sampling knobs are reloadable; they rebuild
 * the engine's default description / sampler. `buildParlerParams`
 * re-validates afterwards, so a description/template conflict introduced by a
 * reload still throws (and the caller rolls the settings back).
 */
export declare function applyParlerReload(setup: EngineSetup, newConfig: Record<string, unknown>): void;
