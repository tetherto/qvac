/**
 * `reload()` configuration: which settings a reload may rewrite, applied
 * against a snapshot so a rejected reload leaves the instance untouched.
 */
import type { TTSConfigurationParams } from "../tts";
import type { EngineSetup } from "./engineSetup";
/**
 * Apply the new configuration and build the native parameters from it. A
 * rejected value leaves the instance exactly as it was, so a later partial
 * reload is not validated against state the caller never accepted.
 */
export declare function applyReloadableConfig(setup: EngineSetup, newConfig: Record<string, unknown>): TTSConfigurationParams;
