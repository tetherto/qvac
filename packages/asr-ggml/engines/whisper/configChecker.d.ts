export interface WhisperConfigurationParams {
    whisperConfig: Record<string, unknown>;
    contextParams: Record<string, unknown>;
    miscConfig: Record<string, unknown>;
    audio_format?: string;
    backendsDir?: string;
    /** Unified native `createInstance` dispatch key; ignored by the checker. */
    engineType?: string;
}
export declare function checkConfig(configObject: WhisperConfigurationParams): void;
