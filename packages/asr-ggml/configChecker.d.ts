export interface WhisperConfigurationParams {
    whisperConfig: Record<string, unknown>;
    contextParams: Record<string, unknown>;
    miscConfig: Record<string, unknown>;
    audio_format?: string;
    backendsDir?: string;
}
export declare function checkConfig(configObject: WhisperConfigurationParams): void;
