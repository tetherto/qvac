/**
 * Flat native configuration object, read 1:1 by the C++ JSAdapter
 * (buildAcestepConfig). Either `modelDir` (auto-classify the four GGUFs) or the
 * explicit per-stage paths are set. The numeric/bool fields are REQUIRED by the
 * native side (it carries no defaults); the high-level class fills them in.
 */
export interface AudioGenConfigurationParams {
    engineType?: string;
    modelDir?: string;
    textEncModelPath?: string;
    lmModelPath?: string;
    ditModelPath?: string;
    vaeModelPath?: string;
    inferenceSteps?: number;
    shift?: number;
    useGPU?: boolean;
    nGpuLayers?: number;
    threads?: number;
    /**
     * Prebuilds root the native side scans (after appending the per-target
     * BACKENDS_SUBDIR) for dlopen'd ggml backend modules. Required on arm64, where
     * the CPU backend ships as per-microarch MODULE .so files.
     */
    backendsDir?: string;
}
/** One generation job handed to the native `runJob`. */
export interface AudioGenJobData {
    type: string;
    input: string;
    lyrics?: string;
    seed?: number;
    vocalLanguage?: string;
    bpm?: number;
    keyscale?: string;
    timesignature?: string;
    duration?: number;
}
/** Native output event: (handle, event, data, error). */
export type AudioGenOutputCallback = (handle: unknown, event: unknown, data: unknown, error: unknown) => void;
/** The C++ addon surface exposed through binding.js (require.addon()). */
export interface AudioGenBinding {
    createInstance(owner: AudioGenInterface, configuration: AudioGenConfigurationParams, outputCallback: AudioGenOutputCallback | null): object;
    activate(handle: object | null): Promise<void>;
    runJob(handle: object | null, data: AudioGenJobData): void | Promise<void>;
    cancel(handle: object | null): Promise<void>;
    destroyInstance(handle: object): Promise<void> | void;
}
/** An interface between the Bare addon in C++ and the JS runtime. */
export declare class AudioGenInterface {
    private readonly _binding;
    private _handle;
    constructor(binding: AudioGenBinding, configuration?: AudioGenConfigurationParams, outputCallback?: AudioGenOutputCallback | null);
    activate(): Promise<void>;
    runJob(data: AudioGenJobData): Promise<void>;
    cancel(): Promise<void>;
    destroyInstance(): Promise<void>;
}
