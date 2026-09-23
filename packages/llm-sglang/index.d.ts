import { type QvacResponse } from '@qvac/infer-base';
import { type AddonLogger } from './addon';
export interface TextMessage {
    role: string;
    content: string;
    type?: undefined;
}
export interface MediaMessage {
    role: 'user';
    type: 'media' | 'image' | 'audio' | 'video';
    content: Uint8Array | string;
    mediaType?: string;
    mime?: string;
}
export type Message = TextMessage | MediaMessage;
export interface GenerationParams {
    temp?: number;
    temperature?: number;
    top_p?: number;
    top_k?: number;
    predict?: number;
    max_tokens?: number;
    seed?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    repeat_penalty?: number;
    repetition_penalty?: number;
    grammar?: string;
    json_schema?: string | Record<string, unknown>;
}
export interface RunOptions {
    generationParams?: GenerationParams;
}
export interface LlmSglangConfig {
    baseUrl?: string;
    host?: string;
    port?: number;
    readyTimeoutMs?: number;
    maxConnections?: number;
    tpSize?: number;
    epSize?: number;
    dpSize?: number;
    ppSize?: number;
    cpSize?: number;
    contextLength?: number;
    maxTotalTokens?: number;
    maxRunningRequests?: number;
    maxPrefillTokens?: number;
    memFractionStatic?: number;
    cudaGraphBatchSizes?: string;
    cachePolicy?: string;
    maxHttpRequests?: number;
    maxRequestBytes?: number;
    apiKey?: string;
    corsAllowOrigin?: string;
    queueTimeout?: number;
    requestTimeout?: number;
    streamIdleTimeout?: number;
    cudaGraph?: boolean;
    extraArgs?: string[];
    artifacts?: string;
}
export interface LlmSglangArgs {
    files?: {
        model?: string[];
    };
    config?: LlmSglangConfig;
    logger?: AddonLogger | null;
}
export declare function validateMessages(messages: unknown): asserts messages is Message[];
export declare class LlmSglang {
    readonly logger: AddonLogger | null;
    private readonly files;
    private readonly config;
    private addon;
    private server;
    private readonly job;
    private readonly runExclusive;
    private loaded;
    constructor({ files, config, logger }?: LlmSglangArgs);
    load(): Promise<void>;
    run(messages: Message[], runOptions?: RunOptions): QvacResponse<string>;
    cancel(): Promise<void>;
    unload(): Promise<void>;
    private ensureServer;
    private stopServer;
    private onOutput;
}
export default LlmSglang;
