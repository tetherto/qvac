import type { FitConfig, FitResult } from './index';
export declare const FIT_PROCESS_PROTOCOL_VERSION: 1;
export declare const FIT_PROCESS_MAX_REQUEST_BYTES: number;
export declare const FIT_PROCESS_MAX_RESPONSE_BYTES: number;
export interface FitProcessRequest {
    version: typeof FIT_PROCESS_PROTOCOL_VERSION;
    config: FitConfig;
}
export type FitProcessResponse = {
    version: typeof FIT_PROCESS_PROTOCOL_VERSION;
    status: 'completed';
    result: FitResult;
} | {
    version: typeof FIT_PROCESS_PROTOCOL_VERSION;
    status: 'invocation-error';
    error: {
        name: string;
        message: string;
    };
};
export declare function encodeFitProcessRequest(config: FitConfig): string;
export declare function parseFitProcessResponse(value: unknown): FitProcessResponse;
export declare function resolveFitProcessRunnerPath(): string;
