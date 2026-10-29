import type { TTSConfigurationParams } from "../tts";
import type { EngineType } from "./engineIds";
export interface FabricOptions {
    maxNewTokens?: number;
    textTemperature?: number;
    textTopP?: number;
    textTopK?: number;
    audioTemperature?: number;
    audioTopP?: number;
    audioTopK?: number;
    audioRepetitionPenalty?: number;
    coremlDecoder?: boolean;
    coremlComputeUnits?: "all" | "cpu_and_ane" | "cpu_and_gpu" | "cpu_only";
    coremlStrict?: boolean;
    precision?: "auto" | "f32" | "f16" | "q8_0";
    f16Attn?: number;
    f16Weights?: number;
    f16WeightsDenyList?: string[];
    kvAttnType?: number;
    vulkanEnvOverrides?: Record<string, string>;
    voiceStyleTtl?: number[] | Float32Array;
    voiceStyleDp?: number[] | Float32Array;
    forceSpeechTokens?: number[];
}
export declare function validateBackendOption(engine: EngineType, backend: unknown): void;
export declare function resolveFabricOptions(engine: EngineType, options: FabricOptions & {
    nCtx?: number;
}): FabricOptions;
export declare function assignFabricOptions(settings: FabricOptions, parameters: TTSConfigurationParams): void;
