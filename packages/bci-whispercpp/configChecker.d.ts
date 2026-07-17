/**
 * Configuration object passed to the native BCI addon. `checkConfig`
 * validates the presence of the required sections and rejects unknown keys.
 */
export interface BCIConfigurationParams {
    whisperConfig: Record<string, unknown>;
    contextParams: Record<string, unknown>;
    miscConfig: Record<string, unknown>;
    bciConfig?: Record<string, unknown>;
    backendsDir?: string;
    embedderPath?: string;
}
/**
 * Validates BCI addon configuration. Returns nothing, or throws if invalid.
 */
export declare function checkConfig(configObject: BCIConfigurationParams): void;
