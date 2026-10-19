/**
 * `reload()` configuration: which settings a reload may rewrite, applied
 * against a snapshot so a rejected reload leaves the instance untouched.
 */
import type { TTSConfigurationParams } from "../tts";
import {
  assertConditioningConsistency,
  type TTSConditioningFields,
} from "./conditioning";
import { buildNativeParams } from "./engineParams";
import type {
  EngineSetup,
  SynthesisSettings,
  TTSGgmlRuntimeConfig,
} from "./engineSetup";
import { applyAudio8Reload } from "./engines/audio8";
import { applyMossReload, assertMossReloadKeepsVoice } from "./engines/moss";
import { applyParlerReload } from "./engines/parler";
import { validateOutputSampleRate } from "./setup";

/** Everything reload() may overwrite, so a rejected reload can undo itself. */
interface ReloadableState {
  language?: string;
  useGPU?: boolean;
  outputSampleRate: number | null;
  settings: SynthesisSettings;
}

function captureReloadableState(setup: EngineSetup): ReloadableState {
  return {
    language: setup.config.language,
    useGPU: setup.config.useGPU,
    outputSampleRate: setup.outputSampleRate,
    settings: { ...setup.settings },
  };
}

function restoreReloadableState(
  setup: EngineSetup,
  state: ReloadableState,
): void {
  setup.config.language = state.language;
  setup.config.useGPU = state.useGPU;
  setup.outputSampleRate = state.outputSampleRate;
  const live = setup.settings as Record<string, unknown>;
  const snapshot = state.settings as Record<string, unknown>;
  for (const key of new Set([...Object.keys(live), ...Object.keys(snapshot)])) {
    live[key] = snapshot[key];
  }
}

function applyReloadableRuntimeConfig(
  setup: EngineSetup,
  newConfig: Record<string, unknown>,
): void {
  assertMossReloadKeepsVoice(setup, newConfig);
  const runtimeConfig = newConfig as Partial<TTSGgmlRuntimeConfig>;
  if (runtimeConfig.language !== undefined) {
    setup.config.language = runtimeConfig.language;
  }
  if (runtimeConfig.useGPU !== undefined) {
    setup.config.useGPU = runtimeConfig.useGPU;
  }
  if (runtimeConfig.outputSampleRate !== undefined) {
    setup.outputSampleRate = validateOutputSampleRate(
      runtimeConfig.outputSampleRate,
    );
  }
  applyAudio8Reload(setup, newConfig);
  applyMossReload(setup, newConfig);
}

// Cross-engine conditioning is reloadable on every engine that supports it,
// so both families change emotion the same way.
function applyReloadableConditioning(
  setup: EngineSetup,
  newConfig: Record<string, unknown>,
): void {
  const conditioning = newConfig as Partial<TTSConditioningFields>;
  if (
    conditioning.emotion === undefined &&
    conditioning.pace === undefined
  ) {
    return;
  }
  if (conditioning.emotion !== undefined) {
    setup.settings.emotion = conditioning.emotion;
  }
  if (conditioning.pace !== undefined) {
    setup.settings.pace = conditioning.pace;
  }
  assertConditioningConsistency(setup, "reload");
}

/**
 * Apply the new configuration and build the native parameters from it. A
 * rejected value leaves the instance exactly as it was, so a later partial
 * reload is not validated against state the caller never accepted.
 */
export function applyReloadableConfig(
  setup: EngineSetup,
  newConfig: Record<string, unknown>,
): TTSConfigurationParams {
  const snapshot = captureReloadableState(setup);
  try {
    applyReloadableRuntimeConfig(setup, newConfig);
    applyReloadableConditioning(setup, newConfig);
    applyParlerReload(setup, newConfig);
    return buildNativeParams(setup);
  } catch (error) {
    restoreReloadableState(setup, snapshot);
    throw error;
  }
}
