export interface TTSConfigurationParams {
    [key: string]: string | number | boolean | undefined;
}
export interface TTSJobData {
    type: string;
    input: string;
}
export interface TTSWeightData {
    filename: string;
    chunk: Uint8Array;
    completed: boolean;
}
export type TTSOutputCallback = (addon: unknown, event: unknown, data: unknown, error: unknown) => void;
export interface TTSBinding {
    createInstance(owner: TTSInterface, configuration: TTSConfigurationParams, outputCallback: TTSOutputCallback | null): object;
    activate(handle: object | null): Promise<void>;
    runJob(handle: object | null, data: TTSJobData): void;
    loadWeights(handle: object | null, weightsData: TTSWeightData): void;
    cancel(handle: object | null): Promise<void>;
    destroyInstance(handle: object): Promise<void> | void;
}
/** An interface between the Bare addon in C++ and the JS runtime. */
export declare class TTSInterface {
    private readonly _binding;
    private _handle;
    constructor(binding: TTSBinding, configuration?: TTSConfigurationParams, outputCallback?: TTSOutputCallback | null);
    activate(): Promise<void>;
    runJob(data: TTSJobData): Promise<void>;
    loadWeights(weightsData: TTSWeightData): Promise<void>;
    cancel(): Promise<void>;
    destroyInstance(): Promise<void>;
    unload(): Promise<void>;
}
