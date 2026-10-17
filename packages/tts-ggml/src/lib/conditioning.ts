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
  type EngineType,
} from "./engineIds";
import type { EngineSetup } from "./engineSetup";

// Canonical cross-engine conditioning vocabulary. This is a MIRROR, not the
// source of truth: tts-cpp owns it in include/tts-cpp/voice_controls.h, and
// test/unit/voice-controls.test.js pins this copy against the native lists.
export const EMOTIONS = [
  "command",
  "anger",
  "narration",
  "conversation",
  "disgust",
  "fear",
  "happy",
  "neutral",
  "proper noun",
  "news",
  "sad",
  "surprise",
] as const;
export const PACES = ["slow", "moderate", "fast"] as const;
export type Emotion = (typeof EMOTIONS)[number];
export type Pace = (typeof PACES)[number];
export const CONDITIONING_KEYS = ["emotion", "pace"] as const;
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

// Per-engine supported subsets, mirroring controls::supported_emotions() /
// supported_paces(). An empty list means the engine has no such control.
const ENGINE_EMOTIONS: Record<EngineType, readonly Emotion[]> = {
  [ENGINE_PARLER]: EMOTIONS,
  // Only the emotions Fun-CosyVoice3 has a trained instruction for; the rest,
  // and the upstream spelling "angry", are rejected rather than paraphrased.
  [ENGINE_COSYVOICE3]: ["anger", "happy", "neutral", "sad"],
  [ENGINE_SUPERTONIC]: [],
  [ENGINE_CHATTERBOX]: [],
  [ENGINE_POCKET]: [],
  [ENGINE_AUDIO8]: [],
  [ENGINE_MOSS]: [],
  [ENGINE_MOSS_SFX]: [],
  [ENGINE_MOSS_SPEECH]: [],
};

const ENGINE_PACES: Record<EngineType, readonly Pace[]> = {
  [ENGINE_PARLER]: PACES, // rendered into the training caption
  [ENGINE_COSYVOICE3]: PACES, // slow/fast -> instruct; moderate -> none
  [ENGINE_SUPERTONIC]: PACES, // mapped onto the duration multiplier
  [ENGINE_CHATTERBOX]: [], // time-stretch only; use `speed`
  [ENGINE_POCKET]: [],
  [ENGINE_AUDIO8]: [], // no rate control at all
  [ENGINE_MOSS]: [],
  [ENGINE_MOSS_SFX]: [],
  [ENGINE_MOSS_SPEECH]: [],
};

// Which channels an engine can change per call. Supertonic takes its pace
// through EngineOptions when the engine is built, and tts-cpp exposes no
// per-call surface for it, so it only moves at construction or reload().
// tts-cpp engine names (tts-cpp/voice_controls.h engine_name) that differ from

const ENGINE_PER_CALL_CONDITIONING: Record<
  EngineType,
  readonly ConditioningKey[]
> = {
  [ENGINE_PARLER]: CONDITIONING_KEYS,
  [ENGINE_COSYVOICE3]: CONDITIONING_KEYS,
  [ENGINE_SUPERTONIC]: [],
  [ENGINE_CHATTERBOX]: [],
  [ENGINE_POCKET]: [],
  [ENGINE_AUDIO8]: [],
  [ENGINE_MOSS]: [],
  [ENGINE_MOSS_SFX]: [],
  [ENGINE_MOSS_SPEECH]: [],
};

/** Collect the cross-engine conditioning properties present on `source`. */
export function pickConditioningFields(
  source: TTSConditioningFields | null | undefined,
): ConditioningFields | undefined {
  if (source == null || typeof source !== "object") return undefined;
  const out: ConditioningFields = {};
  let any = false;
  for (const key of CONDITIONING_KEYS) {
    const value: string | undefined = source[key];
    if (value != null && value !== "") {
      out[key] = value;
      any = true;
    }
  }
  return any ? out : undefined;
}

export function assertCanonicalValue(
  value: string,
  canonical: readonly string[],
  kind: string,
): void {
  if (canonical.includes(value.toLowerCase())) return;
  throw new Error(
    `tts-ggml: invalid ${kind} "${value}". ` +
      `Valid ${kind}s: ${canonical.join(", ")}.`,
  );
}

export function supportedValues(engine: EngineType, kind: ConditioningKey) {
  return kind === "emotion" ? ENGINE_EMOTIONS[engine] : ENGINE_PACES[engine];
}

export function assertEngineSupports(
  engine: EngineType,
  kind: ConditioningKey,
  value: string,
): void {
  const supported: readonly string[] = supportedValues(engine, kind);
  if (supported.length === 0) {
    const hint =
      kind === "pace"
        ? "; use `speed` (an exact multiplier) instead"
        : "";
    throw new Error(
      `tts-ggml: the ${engine} engine does not support \`${kind}\`${hint}`,
    );
  }
  if (supported.includes(value.toLowerCase())) return;
  throw new Error(
    `tts-ggml: ${kind} "${value}" is not supported by the ${engine} engine. ` +
      `${engine} supports: ${supported.join(", ")}.`,
  );
}

/**
 * Validate emotion/pace against the canonical vocabulary first (so a typo reads
 * clearly), then against what this engine actually supports.
 */
export function validateConditioning(
  engine: EngineType,
  fields: ConditioningFields | undefined,
): void {
  if (!fields) return;
  if (fields.emotion != null) {
    assertCanonicalValue(fields.emotion, EMOTIONS, "emotion");
    assertEngineSupports(engine, "emotion", fields.emotion);
  }
  if (fields.pace != null) {
    assertCanonicalValue(fields.pace, PACES, "pace");
    assertEngineSupports(engine, "pace", fields.pace);
  }
}

/**
 * Reject a channel the engine supports but cannot change per call, so it is
 * never accepted here and then dropped on the way to the engine. Runs after
 * validateConditioning so an engine with no such control keeps its own message.
 */
export function assertPerCallConditioning(
  engine: EngineType,
  fields: ConditioningFields | undefined,
  where: string,
): void {
  if (!fields) return;
  const perCall = ENGINE_PER_CALL_CONDITIONING[engine];
  const fixed = CONDITIONING_KEYS.filter(
    (key) => fields[key] != null && !perCall.includes(key),
  );
  if (fixed.length === 0) return;
  throw new Error(
    `tts-ggml: ${where}: ${engine} applies ` +
      `${fixed.map((key) => `\`${key}\``).join(", ")} when the engine is ` +
      `built, so it cannot change per call; set it in the constructor or ` +
      `reload({ ${fixed.join(", ")} })`,
  );
}

// CosyVoice3 is trained on one instruction per synthesis. Only `pace: moderate`
// resolves to no instruction, so it is the one value that never conflicts; every
// emotion carries a trained instruction, `neutral` included.
export const COSYVOICE_DISENGAGED: Record<string, string> = {
  pace: "moderate",
};

export function engagedCosyvoiceControls(
  fields: ConditioningFields | undefined,
  instruct: string | undefined,
): string[] {
  const engaged: string[] = [];
  for (const key of CONDITIONING_KEYS) {
    const value = fields?.[key];
    if (value != null && value.toLowerCase() !== COSYVOICE_DISENGAGED[key]) {
      engaged.push(`${key}="${value}"`);
    }
  }
  if (instruct != null && instruct !== "") engaged.push("instruct");
  return engaged;
}

export function assertSingleCosyvoiceControl(
  fields: ConditioningFields | undefined,
  instruct: string | undefined,
  where: string,
): void {
  const engaged = engagedCosyvoiceControls(fields, instruct);
  if (engaged.length <= 1) return;
  throw new Error(
    `tts-ggml: ${where}: conflicting conditioning controls ` +
      `(${engaged.join(", ")}); cosyvoice3 is trained on one instruction per ` +
      `synthesis -- set exactly one (pace="moderate" disengages a channel)`,
  );
}

/**
 * Validate the configured emotion/pace against this engine, and enforce
 * CosyVoice3's one-instruction-per-synthesis rule. Runs at construction and
 * again after a reload rewrites either channel.
 */
export function assertConditioningConsistency(
  setup: EngineSetup,
  where: string,
): void {
  const fields = pickConditioningFields({
    emotion: setup.settings.emotion as Emotion | undefined,
    pace: setup.settings.pace as Pace | undefined,
  });
  validateConditioning(setup.engineType, fields);
  if (setup.engineType === ENGINE_COSYVOICE3) {
    assertSingleCosyvoiceControl(fields, setup.settings.instruct, where);
  }
}
