/** Picks the native parameter builder of the configured engine. */
import type { TTSConfigurationParams } from "../tts";
import type { EngineSetup } from "./engineSetup";
/** The `createInstance` parameters for the current setup. */
export declare function buildNativeParams(setup: EngineSetup): TTSConfigurationParams;
