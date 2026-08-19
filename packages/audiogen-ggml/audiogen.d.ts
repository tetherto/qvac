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
/** Stable string values serialized across the JS -> native addon boundary. */
export declare enum AudioEditOperationType {
    FlowEdit = "flow-edit",
    Repaint = "repaint"
}
export declare enum RepaintMode {
    Conservative = "conservative",
    Balanced = "balanced",
    Aggressive = "aggressive"
}
export interface AudioEditOperationJobData {
    type: AudioEditOperationType;
    sourceCaption?: string;
    sourceLyrics?: string;
    targetCaption?: string;
    targetLyrics?: string;
    caption?: string;
    lyrics?: string;
    nMin?: number;
    nMax?: number;
    nAvg?: number;
    start?: number;
    end?: number;
    mode?: RepaintMode;
    strength?: number;
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
    lmTemperature?: number;
    lmTopP?: number;
    lmTopK?: number;
    lmCfgScale?: number;
    lmPhase1?: boolean;
    dcwEnabled?: boolean;
    dcwScaler?: number;
    dcwHighScaler?: number;
    audioCodes?: Int32Array;
    referenceAudio?: Float32Array;
    sourceAudio?: Float32Array;
    taskType?: string;
    audioCoverStrength?: number;
    coverNoiseStrength?: number;
    editOperations?: AudioEditOperationJobData[];
}
/** Native output event: (handle, event, data, error). */
export type AudioGenOutputCallback = (handle: unknown, event: unknown, data: unknown, error: unknown) => void;
/** The C++ addon surface exposed through binding.js (require.addon()). */
export interface AudioGenBinding {
    createInstance(owner: AudioGenInterface, configuration: AudioGenConfigurationParams, outputCallback: AudioGenOutputCallback | null): object;
    activate(handle: object | null): Promise<void>;
    runJob(handle: object | null, data: AudioGenJobData): boolean | Promise<boolean>;
    cancel(handle: object | null): Promise<void>;
    destroyInstance(handle: object): Promise<void> | void;
}
/** An interface between the Bare addon in C++ and the JS runtime. */
export declare class AudioGenInterface {
    private readonly _binding;
    private _handle;
    constructor(binding: AudioGenBinding, configuration?: AudioGenConfigurationParams, outputCallback?: AudioGenOutputCallback | null);
    activate(): Promise<void>;
    runJob(data: AudioGenJobData): Promise<boolean>;
    cancel(): Promise<void>;
    destroyInstance(): Promise<void>;
}
