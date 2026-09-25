export interface TTSConfigurationParams {
    [key: string]: string | number | boolean | string[] | undefined;
}
export interface TTSJobData {
    type: string;
    input: string;
    description?: string;
    voiceDescription?: string;
    voice?: string;
    emotion?: string;
    pitch?: string;
    pace?: string;
    expressivity?: string;
    noise?: string;
    reverb?: string;
    quality?: string;
    instruct?: string;
    referenceAudio?: string;
    referenceText?: string;
}
export interface TTSWeightData {
    filename: string;
    chunk: Uint8Array;
    completed: boolean;
}
export type TTSOutputCallback = (addon: unknown, event: unknown, data: unknown, error: unknown) => void;
/** getVoiceControls() payload, keyed by tts-cpp's engine names. */
export interface NativeVoiceControls {
    emotions: string[];
    paces: string[];
    engines: Record<string, {
        emotions: string[];
        paces: string[];
    }>;
}
export interface TTSBinding {
    getVoiceControls(): NativeVoiceControls;
    createInstance(owner: TTSInterface, configuration: TTSConfigurationParams, outputCallback: TTSOutputCallback | null): object;
    activate(handle: object | null): Promise<void>;
    runJob(handle: object | null, data: TTSJobData): boolean | void | Promise<boolean | void>;
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
