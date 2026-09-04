export declare const PROTOCOL_VERSION: 1;
export declare const MAX_REQUEST_BYTES: number;
export declare const MAX_EVENT_BYTES: number;
export declare const MINIMAX_SAMPLE_RATE = 44100;
export declare const MINIMAX_CHANNELS = 2;
export interface RuntimeConfig {
    modelDir: string;
    cacheDir?: string;
    device?: 'cuda';
    torchDtype?: 'bfloat16';
}
export interface GenerateRequest {
    requestId: string;
    caption: string;
    lyrics: string;
    maxFrames: number;
    seed?: number;
    inferenceSteps?: number;
    cfgScale?: number;
}
export type WorkerRequest = {
    version: typeof PROTOCOL_VERSION;
    op: 'load';
    config: RuntimeConfig;
} | ({
    version: typeof PROTOCOL_VERSION;
    op: 'generate';
} & GenerateRequest) | {
    version: typeof PROTOCOL_VERSION;
    op: 'cancel';
    requestId: string;
} | {
    version: typeof PROTOCOL_VERSION;
    op: 'unload';
};
export type WorkerEvent = {
    version: typeof PROTOCOL_VERSION;
    status: 'loaded';
} | {
    version: typeof PROTOCOL_VERSION;
    status: 'progress';
    requestId: string;
    stage: 'ar' | 'flow';
    step: number;
    total: number;
} | {
    version: typeof PROTOCOL_VERSION;
    status: 'audio';
    requestId: string;
    data: string;
    sampleRate: typeof MINIMAX_SAMPLE_RATE;
    channels: typeof MINIMAX_CHANNELS;
} | {
    version: typeof PROTOCOL_VERSION;
    status: 'completed';
    requestId: string;
    totalTimeMs: number;
} | {
    version: typeof PROTOCOL_VERSION;
    status: 'cancelled';
    requestId: string;
} | {
    version: typeof PROTOCOL_VERSION;
    status: 'unloaded';
} | {
    version: typeof PROTOCOL_VERSION;
    status: 'error';
    error: {
        name: string;
        message: string;
    };
    requestId?: string;
};
export declare function parseWorkerRequest(value: unknown): WorkerRequest;
export declare function encodeWorkerRequest(request: WorkerRequest): string;
export declare function parseWorkerEvent(value: unknown): WorkerEvent;
