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
export interface FitProcessOutcome {
    response: FitProcessResponse;
    exitCode: 0 | 1 | 2;
}
export type FitProcessFit = (config: FitConfig) => FitResult;
export declare function encodeFitProcessRequest(config: FitConfig): string;
export declare function parseFitProcessRequest(value: unknown): FitProcessRequest;
export declare function parseFitProcessResponse(value: unknown): FitProcessResponse;
export declare function encodeFitProcessResponse(response: FitProcessResponse): string;
export declare function runFitProcessLine(line: string, fit: FitProcessFit): FitProcessOutcome;
export declare function resolveFitProcessRunnerPath(): string;
