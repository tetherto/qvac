import type { TTSConfigurationParams } from "../tts";
import type { EngineSetup } from "./engineSetup";
/** The knobs every engine in SAMPLING_ENGINES reads. */
export declare function assignSamplingParams(setup: EngineSetup, parameters: TTSConfigurationParams): void;
/**
 * Backend and output plumbing for the engines that take no `language`,
 * where `assignCommonNativeParams` would be the wrong shape.
 */
export declare function assignBackendParams(setup: EngineSetup, parameters: TTSConfigurationParams): void;
export declare function assignCommonNativeParams(setup: EngineSetup, parameters: TTSConfigurationParams): void;
/** LavaSR post-processing paths, shared by every engine that supports them. */
export declare function assignLavasrParams(setup: EngineSetup, parameters: TTSConfigurationParams): void;
