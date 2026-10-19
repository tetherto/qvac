export declare const ENGINE_CHATTERBOX = "chatterbox";
export declare const ENGINE_SUPERTONIC = "supertonic";
export declare const ENGINE_COSYVOICE3 = "cosyvoice3";
export declare const ENGINE_PARLER = "parler";
export declare const ENGINE_AUDIO8 = "audio8";
export declare const ENGINE_MOSS = "moss";
export declare const ENGINE_MOSS_SFX = "moss-sfx";
export declare const ENGINE_MOSS_SPEECH = "moss-speech";
export declare const ENGINE_POCKET = "pocket";
export type EngineType = typeof ENGINE_CHATTERBOX | typeof ENGINE_SUPERTONIC | typeof ENGINE_COSYVOICE3 | typeof ENGINE_PARLER | typeof ENGINE_AUDIO8 | typeof ENGINE_MOSS | typeof ENGINE_MOSS_SFX | typeof ENGINE_MOSS_SPEECH | typeof ENGINE_POCKET;
export declare const ENGINE_TYPES: readonly EngineType[];
export declare function isEngineType(value: unknown): value is EngineType;
/** Engines that draw tokens, and so accept temperature / topK / topP / maxFrames. */
export declare const SAMPLING_ENGINES: readonly string[];
export declare const FABRIC_ENGINE_TYPES: Record<string, EngineType>;
