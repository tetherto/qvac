/**
 * `TTSGgml.getVoiceControls()`: tts-cpp's conditioning vocabulary, re-keyed
 * from tts-cpp's engine names to this package's engine types.
 */
import type { NativeVoiceControls } from "../tts";
import { FABRIC_ENGINE_TYPES } from "./engineIds";
import type { VoiceControlsCatalog } from "./types";

/**
 * Copies the native catalog so callers cannot change the binding's tables.
 * tts-cpp's `cosyvoice` appears as `cosyvoice3`; an engine this package does
 * not wrap keeps its tts-cpp name.
 */
export function toVoiceControlsCatalog(
  native: NativeVoiceControls,
): VoiceControlsCatalog {
  const engines: VoiceControlsCatalog["engines"] = {};
  for (const [name, controls] of Object.entries(native.engines)) {
    engines[FABRIC_ENGINE_TYPES[name] ?? name] = {
      emotions: [...controls.emotions],
      paces: [...controls.paces],
    };
  }
  return {
    emotions: [...native.emotions],
    paces: [...native.paces],
    engines,
  };
}
