export type AddonConfigValue = string | number | boolean | undefined;
export type AddonConfig = Record<string, AddonConfigValue>;
export interface SdConfigurationParams {
    path: string;
    diffusionModelPath?: string;
    highNoiseDiffusionModelPath?: string;
    uncondDiffusionModelPath?: string;
    clipLPath?: string;
    clipGPath?: string;
    t5XxlPath?: string;
    llmPath?: string;
    vaePath?: string;
    clipVisionPath?: string;
    esrganPath?: string;
    audioVaePath?: string;
    embeddingsConnectorsPath?: string;
    config?: AddonConfig;
}
export interface EsrganConfigurationParams {
    esrganPath: string;
    config?: AddonConfig;
}
export interface SdJobParams {
    [key: string]: unknown;
    width?: number;
    height?: number;
    init_image?: Uint8Array;
    init_images?: Uint8Array[];
    control_frames?: Uint8Array[];
}
export interface NativeJobArgs {
    type: 'text';
    input: string;
    initImageBuffer?: Uint8Array;
    initImageBuffers?: Uint8Array[];
    controlFramesBuffers?: Uint8Array[];
}
export interface NativeUpscaleJobArgs {
    type: 'image';
    input: Uint8Array;
    params: string;
}
export type SdOutputCallback = (addon: SdInterface, event: unknown, data: unknown, error: unknown) => void;
export type EsrganOutputCallback = (addon: EsrganUpscalerInterface, event: unknown, data: unknown, error: unknown) => void;
export interface SdBinding {
    createInstance(owner: SdInterface, configurationParams: SdConfigurationParams, outputCallback: SdOutputCallback): object;
    activate(handle: unknown): void;
    cancel(handle: unknown): Promise<void>;
    runJob(handle: unknown, input: NativeJobArgs): Promise<boolean>;
    destroyInstance(handle: unknown): void;
}
export interface EsrganBinding {
    createUpscalerInstance(owner: EsrganUpscalerInterface, configurationParams: EsrganConfigurationParams, outputCallback: EsrganOutputCallback): object;
    activateUpscaler(handle: unknown): void;
    cancel(handle: unknown): Promise<void>;
    runUpscaleJob(handle: unknown, input: NativeUpscaleJobArgs): Promise<boolean>;
    destroyInstance(handle: unknown): void;
}
export type MappedAddonEvent = {
    type: 'Error';
    data: unknown;
    error: unknown;
} | {
    type: 'Output';
    data: Uint8Array | string;
    error: null;
} | {
    type: 'JobEnded';
    data: Record<string, unknown>;
    error: null;
};
/**
 * Normalize a raw native event into `Output` (image bytes or progress
 * tick), `Error`, or `JobEnded`. Returns `null` for unknown shapes
 * (caller logs and skips).
 *
 * Classification priority:
 *   1. Error if rawEvent (string) includes substring "Error"
 *   2. Output if rawData is Uint8Array or string (binary or JSON)
 *   3. JobEnded if rawData is a truthy object (stats payload)
 *   4. Unknown (null) for anything else
 */
export declare function mapAddonEvent(rawEvent: unknown, rawData: unknown, rawError: unknown): MappedAddonEvent | null;
export interface ImageDimensions {
    width: number;
    height: number;
}
/**
 * Extract pixel dimensions from a PNG or JPEG buffer without a full decode.
 *
 * PNG: width/height are stored as big-endian uint32 at bytes 16–23 of the IHDR chunk.
 * JPEG: scan for the first SOFx segment (0xFFCx) which stores height at +5 and width at +7.
 *
 * Returns `{ width, height }` or `null` if the format is not recognised.
 */
export declare function readImageDimensions(buf: Uint8Array): ImageDimensions | null;
/**
 * JavaScript wrapper around the native stable-diffusion.cpp addon.
 * Manages the native handle lifecycle and bridges JS ↔ C++.
 */
export declare class SdInterface {
    private readonly _binding;
    private _handle;
    private readonly _spatialAlign;
    constructor(binding: SdBinding, configurationParams: SdConfigurationParams, outputCallback: SdOutputCallback);
    activate(): Promise<void>;
    cancel(): Promise<void>;
    runJob<T extends object>(rawParams: T): Promise<boolean>;
    private _fillDimsFromImage;
    unload(): Promise<void>;
}
export declare class EsrganUpscalerInterface {
    private readonly _binding;
    private _handle;
    constructor(binding: EsrganBinding, configurationParams: EsrganConfigurationParams, outputCallback: EsrganOutputCallback);
    activate(): Promise<void>;
    cancel(): Promise<void>;
    runJob(imageBytes: Uint8Array, params: Record<string, unknown>): Promise<boolean>;
    unload(): Promise<void>;
}
