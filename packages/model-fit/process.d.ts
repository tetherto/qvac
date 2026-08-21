import type { FitConfig, FitDeviceInventory, FitPlan, FitResult } from './index';
export declare const FIT_PROCESS_PROTOCOL_VERSION: 1;
export declare const FIT_PROCESS_PROTOCOL_VERSION_V2: 2;
export declare const FIT_PROCESS_MAX_REQUEST_BYTES: number;
export declare const FIT_PROCESS_MAX_RESPONSE_BYTES: number;
export interface FitProcessRequestV1 {
    version: typeof FIT_PROCESS_PROTOCOL_VERSION;
    config: FitConfig;
}
export type LlamaLoadKind = 'completion' | 'embedding';
export interface FitLlamaProcessConfig {
    modelPath: string;
    params: Record<string, string>;
    backendsDir?: string;
    marginMiB?: number;
    nCtxMin?: number;
}
export interface FitProcessRequestV2 {
    version: typeof FIT_PROCESS_PROTOCOL_VERSION_V2;
    loadKind: LlamaLoadKind;
    config: FitLlamaProcessConfig;
}
export type FitProcessRequest = FitProcessRequestV1 | FitProcessRequestV2;
export interface FitProcessCompletedResponseV1 {
    version: typeof FIT_PROCESS_PROTOCOL_VERSION;
    status: 'completed';
    result: FitResult;
}
/**
 * Outcome of a raw llama-load fit: everything `FitResult` can be, plus the one
 * outcome only this path produces — a load configuration the normalization
 * cannot represent, which is advisory and must never deny a load.
 *
 * Deliberately a separate type. `fitParams()` can never return
 * `unsupported-config`, so putting it on `FitResult` would oblige every
 * existing low-level consumer to narrow a branch it can never reach.
 */
export type FitLlamaResult = FitResult | ({
    status: 2;
    fits: false;
    reason: 'unsupported-config';
} & Partial<FitPlan> & FitDeviceInventory);
/** Stable, machine-readable explanation of a raw llama-load fit outcome. */
export type FitLlamaReason = FitLlamaResult['reason'];
export interface FitProcessCompletedResponseV2 {
    version: typeof FIT_PROCESS_PROTOCOL_VERSION_V2;
    status: 'completed';
    result: FitLlamaResult;
}
export interface FitProcessInvocationErrorResponseV1 {
    version: typeof FIT_PROCESS_PROTOCOL_VERSION;
    status: 'invocation-error';
    error: {
        name: string;
        message: string;
    };
}
export interface FitProcessInvocationErrorResponseV2 {
    version: typeof FIT_PROCESS_PROTOCOL_VERSION_V2;
    status: 'invocation-error';
    error: {
        name: string;
        message: string;
    };
}
export type FitProcessResponse = FitProcessCompletedResponseV1 | FitProcessCompletedResponseV2 | FitProcessInvocationErrorResponseV1 | FitProcessInvocationErrorResponseV2;
export declare function encodeFitProcessRequest(config: FitConfig): string;
export declare function encodeFitLlamaProcessRequest(loadKind: LlamaLoadKind, config: FitLlamaProcessConfig): string;
export declare function parseFitProcessResponse(value: unknown): FitProcessResponse;
export declare function resolveFitProcessRunnerPath(): string;
