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
export interface WorldConfigurationParams {
    diffusionModelPath: string;
    taehvPath: string;
    scenePath: string;
    config?: AddonConfig;
}
export type WorldOutputCallback = (addon: WorldSessionInterface, event: unknown, data: unknown, error: unknown) => void;
export interface WorldSceneJobParams {
    prompt: string;
    width: number;
    height: number;
    t5Path: string;
    vaePath: string;
    outputPath: string;
}
export interface WorldBinding {
    createWorldInstance(owner: WorldSessionInterface, configurationParams: WorldConfigurationParams, outputCallback: WorldOutputCallback): object;
    activateWorld(handle: unknown): void;
    cancel(handle: unknown): Promise<void>;
    runWorldStepJob(handle: unknown, input: NativeJobArgs): Promise<boolean>;
    runWorldSceneJob(handle: unknown, input: NativeJobArgs): Promise<boolean>;
    destroyInstance(handle: unknown): void;
}
/**
 * Named bits for the walk action mask (WASD move, IJKL look camera).
 * Combine with bitwise OR: `ActionFlag.W | ActionFlag.L`. Values mirror
 * `KEY_ORDER` in world.ts and the native `ActionFlag` enum in
 * WorldSessionModel.hpp (pinned there by test_world_session.cpp and here
 * by the unit matrix).
 */
export declare enum ActionFlag {
    None = 0,
    W = 1,
    A = 2,
    S = 4,
    D = 8,
    I = 16,
    J = 32,
    K = 64,
    L = 128
}
/**
 * JavaScript wrapper around the native ABot-World walk-session addon. The
 * session is a standalone model object (own DiT + taehv decoder + scene
 * pack); frames stream through the same string/typed-array output handlers
 * as batch generation.
 */
export declare class WorldSessionInterface {
    private readonly _binding;
    private _handle;
    constructor(binding: WorldBinding, configurationParams: WorldConfigurationParams, outputCallback: WorldOutputCallback);
    activate(): Promise<void>;
    cancel(): Promise<void>;
    /**
     * Generate the next block under an 8-key action mask — a bitwise OR of
     * `ActionFlag` values (bit 0..7 = W,A,S,D,I,J,K,L held).
     * @returns true if the job was accepted, false if busy
     */
    runStep(actionMask: ActionFlag | number): Promise<boolean>;
    /**
     * Create a scene pack natively (umT5 prompt encode + Wan2.2 VAE first-frame
     * encode). Standalone: works before/without activate().
     * @returns true if the job was accepted, false if busy
     */
    runSceneCreate(params: WorldSceneJobParams, imageBytes: Uint8Array): Promise<boolean>;
    unload(): Promise<void>;
}
