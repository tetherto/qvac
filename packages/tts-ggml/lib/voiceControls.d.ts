/**
 * `TTSGgml.getVoiceControls()`: tts-cpp's conditioning vocabulary, re-keyed
 * from tts-cpp's engine names to this package's engine types.
 */
import type { NativeVoiceControls } from "../tts";
import type { VoiceControlsCatalog } from "./types";
/**
 * Copies the native catalog so callers cannot change the binding's tables.
 * tts-cpp's `cosyvoice` appears as `cosyvoice3`; an engine this package does
 * not wrap keeps its tts-cpp name.
 */
export declare function toVoiceControlsCatalog(native: NativeVoiceControls): VoiceControlsCatalog;
