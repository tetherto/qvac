export const ENGINE_CHATTERBOX = "chatterbox";
export const ENGINE_SUPERTONIC = "supertonic";
// CosyVoice3 (Fun-CosyVoice3-0.5B / 1.5B). Ships as a small set of GGUFs
// (cosyvoice3-{llm,flow,hift}-*.gguf) plus voice.gguf, vocab.json and
// merges.txt; a modelDir holding them (or an explicit
// `files.cosyvoiceModelDir`) routes here.
export const ENGINE_COSYVOICE3 = "cosyvoice3";
export const ENGINE_PARLER = "parler";
export const ENGINE_AUDIO8 = "audio8";
export const ENGINE_MOSS = "moss";
export const ENGINE_MOSS_SFX = "moss-sfx";
export const ENGINE_MOSS_SPEECH = "moss-speech";
export const ENGINE_POCKET = "pocket";

export type EngineType =
  | typeof ENGINE_CHATTERBOX
  | typeof ENGINE_SUPERTONIC
  | typeof ENGINE_COSYVOICE3
  | typeof ENGINE_PARLER
  | typeof ENGINE_AUDIO8
  | typeof ENGINE_MOSS
  | typeof ENGINE_MOSS_SFX
  | typeof ENGINE_MOSS_SPEECH
  | typeof ENGINE_POCKET;

export const ENGINE_TYPES: readonly EngineType[] = [
  ENGINE_CHATTERBOX,
  ENGINE_SUPERTONIC,
  ENGINE_COSYVOICE3,
  ENGINE_PARLER,
  ENGINE_AUDIO8,
  ENGINE_MOSS,
  ENGINE_MOSS_SFX,
  ENGINE_MOSS_SPEECH,
  ENGINE_POCKET,
];

export function isEngineType(value: unknown): value is EngineType {
  return (
    typeof value === "string" &&
    (ENGINE_TYPES as readonly string[]).includes(value)
  );
}

/** Engines that draw tokens, and so accept temperature / topK / topP / maxFrames. */
export const SAMPLING_ENGINES: readonly string[] = [ENGINE_PARLER, ENGINE_AUDIO8];

// tts-cpp engine names (tts-cpp/voice_controls.h engine_name) that differ from
// this package's engine types.
export const FABRIC_ENGINE_TYPES: Record<string, EngineType> = {
  cosyvoice: ENGINE_COSYVOICE3,
};
