import { type EngineType } from "./engineIds";
import type { EngineSetup } from "./engineSetup";
export declare const EMOTIONS: readonly ["command", "anger", "narration", "conversation", "disgust", "fear", "happy", "neutral", "proper noun", "news", "sad", "surprise"];
export declare const PACES: readonly ["slow", "moderate", "fast"];
export type Emotion = (typeof EMOTIONS)[number];
export type Pace = (typeof PACES)[number];
export declare const CONDITIONING_KEYS: readonly ["emotion", "pace"];
export type ConditioningKey = (typeof CONDITIONING_KEYS)[number];
export type ConditioningFields = Partial<Record<ConditioningKey, string>>;
/**
 * Cross-engine conditioning. Accepted at construction and on `reload()` by
 * every engine that supports them, and per call by Parler and CosyVoice3. A
 * value outside the canonical vocabulary, outside the engine's supported
 * subset, or on a channel the engine cannot change per call, throws naming the
 * alternative -- nothing is silently degraded.
 */
export interface TTSConditioningFields {
    /** Speaking style. Parler: all 12. CosyVoice3: anger|happy|neutral|sad. */
    emotion?: Emotion;
    /**
     * Speaking rate. Parler / CosyVoice3 / Supertonic. Supertonic conditions its
     * engine at construction, so its pace only moves there or via `reload()`.
     */
    pace?: Pace;
}
/** Collect the cross-engine conditioning properties present on `source`. */
export declare function pickConditioningFields(source: TTSConditioningFields | null | undefined): ConditioningFields | undefined;
export declare function assertCanonicalValue(value: string, canonical: readonly string[], kind: string): void;
export declare function supportedValues(engine: EngineType, kind: ConditioningKey): readonly ("command" | "anger" | "narration" | "conversation" | "disgust" | "fear" | "happy" | "neutral" | "proper noun" | "news" | "sad" | "surprise")[] | readonly ("slow" | "moderate" | "fast")[];
export declare function assertEngineSupports(engine: EngineType, kind: ConditioningKey, value: string): void;
/**
 * Validate emotion/pace against the canonical vocabulary first (so a typo reads
 * clearly), then against what this engine actually supports.
 */
export declare function validateConditioning(engine: EngineType, fields: ConditioningFields | undefined): void;
/**
 * Reject a channel the engine supports but cannot change per call, so it is
 * never accepted here and then dropped on the way to the engine. Runs after
 * validateConditioning so an engine with no such control keeps its own message.
 */
export declare function assertPerCallConditioning(engine: EngineType, fields: ConditioningFields | undefined, where: string): void;
export declare const COSYVOICE_DISENGAGED: Record<string, string>;
export declare function engagedCosyvoiceControls(fields: ConditioningFields | undefined, instruct: string | undefined): string[];
export declare function assertSingleCosyvoiceControl(fields: ConditioningFields | undefined, instruct: string | undefined, where: string): void;
/**
 * Validate the configured emotion/pace against this engine, and enforce
 * CosyVoice3's one-instruction-per-synthesis rule. Runs at construction and
 * again after a reload rewrites either channel.
 */
export declare function assertConditioningConsistency(setup: EngineSetup, where: string): void;
