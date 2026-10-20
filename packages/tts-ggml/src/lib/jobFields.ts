import {
  assertPerCallConditioning,
  assertSingleCosyvoiceControl,
  pickConditioningFields,
  validateConditioning,
} from "./conditioning";
import { ENGINE_COSYVOICE3, ENGINE_MOSS_SPEECH, ENGINE_PARLER } from "./engineIds";
import type { EngineSetup } from "./engineSetup";
import {
  resolveAudio8JobFields,
  type Audio8VoiceFields,
  type Audio8VoiceFieldsResolved,
} from "./engines/audio8";
import { resolveJobInstruct, type CosyvoiceJobFields } from "./engines/cosyvoice";
import {
  resolveSoundEffectJobFields,
  type MossSoundEffectFields,
} from "./engines/mossSoundEffect";
import {
  pickSpeechFields,
  resolveSpeechJobFields,
  type MossSpeechFields,
  type MossSpeechJobFields,
} from "./engines/mossSpeech";
import {
  PARLER_ONLY_KEYS,
  resolveParlerJobFields,
  type ParlerDescFields,
  type ParlerJobSource,
} from "./engines/parler";
import { keysPresent } from "./options";

/** Per-call engine fields forwarded verbatim onto the native job object. */
export type JobFields = ParlerDescFields &
  Audio8VoiceFieldsResolved &
  MossSoundEffectFields &
  MossSpeechJobFields & { instruct?: string };

/** Everything a run input or streaming options object may carry per call. */
export type JobFieldSource = ParlerJobSource &
  Audio8VoiceFields &
  CosyvoiceJobFields &
  MossSoundEffectFields &
  MossSpeechFields & { input?: string };

/**
 * The per-call surface of a non-Parler engine: only the cross-engine
 * emotion/pace it declares support for, never Parler's template fields.
 */
function resolveConditioningJobFields(
  setup: EngineSetup,
  source: ParlerJobSource | null | undefined,
  where: string,
  instruct: string | undefined,
): ParlerDescFields | undefined {
  const parlerOnly = keysPresent(source, PARLER_ONLY_KEYS);
  if (parlerOnly.length > 0) {
    throw new Error(
      `tts-ggml: ${where}: per-call description/voice-template options ` +
        `are parler-only (engine is ${setup.engineType}; got ` +
        `${parlerOnly.join(", ")})`,
    );
  }
  const fields = pickConditioningFields(source);
  if (!fields) return undefined;
  validateConditioning(setup.engineType, fields);
  assertPerCallConditioning(setup.engineType, fields, where);
  if (setup.engineType === ENGINE_COSYVOICE3) {
    // A per-call control replaces the constructor's, so only the per-call
    // fields participate in the one-instruction count.
    assertSingleCosyvoiceControl(fields, instruct, where);
  }
  return fields;
}

function assertNoSpeechFields(
  setup: EngineSetup,
  source: MossSpeechFields | null | undefined,
  where: string,
): void {
  const fields = pickSpeechFields(source);
  if (!fields) return;
  throw new Error(
    `tts-ggml: ${where}: ${Object.keys(fields).join(", ")} are ` +
      `moss-speech-only options (engine is ${setup.engineType})`,
  );
}

function assertNoOtherEngineFields(
  setup: EngineSetup,
  source: (ParlerJobSource & Audio8VoiceFields & CosyvoiceJobFields & MossSoundEffectFields) | null | undefined,
  where: string,
): void {
  resolveConditioningJobFields(setup, source, where, resolveJobInstruct(setup, source, where));
  resolveAudio8JobFields(setup, source, where);
  resolveSoundEffectJobFields(setup, source, where);
}

/**
 * The per-call fields of whichever engine is loaded, if any are set. Parler
 * takes the full description/template surface, Audio8 its voice override,
 * and every engine the cross-engine conditioning it supports.
 */
export function resolveJobFields(
  setup: EngineSetup,
  source: JobFieldSource | null | undefined,
  where: string,
): JobFields | undefined {
  if (setup.engineType === ENGINE_MOSS_SPEECH) {
    assertNoOtherEngineFields(setup, source, where);
    return resolveSpeechJobFields(source, where);
  }
  const instruct = resolveJobInstruct(setup, source, where);
  const engineFields =
    setup.engineType === ENGINE_PARLER
      ? resolveParlerJobFields(setup, source, where)
      : resolveConditioningJobFields(setup, source, where, instruct);
  const audio8 = resolveAudio8JobFields(setup, source, where);
  const soundEffect = resolveSoundEffectJobFields(setup, source, where);
  assertNoSpeechFields(setup, source, where);
  if (!engineFields && !audio8 && !soundEffect && instruct === undefined) {
    return undefined;
  }
  return {
    ...(engineFields ?? {}),
    ...(audio8 ?? {}),
    ...(soundEffect ?? {}),
    ...(instruct === undefined ? {} : { instruct }),
  };
}
