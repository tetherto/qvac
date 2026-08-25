import type { FitConfig, FitResult } from './index';
import { type FitLlamaProcessConfig, type FitLlamaResult, type FitProcessRequest, type FitProcessResponse, type LlamaLoadKind } from './process';
export interface FitProcessOutcome {
    response: FitProcessResponse;
    responseLine: string;
    exitCode: 0 | 1 | 2;
}
export type FitProcessFit = (config: FitConfig) => FitResult;
export type FitProcessLlamaFit = (loadKind: LlamaLoadKind, config: FitLlamaProcessConfig) => FitLlamaResult;
export declare function parseFitProcessRequest(value: unknown): FitProcessRequest;
export declare function encodeFitProcessResponse(response: FitProcessResponse): string;
export declare function runFitProcessLine(line: string, fit: FitProcessFit, fitLlama?: FitProcessLlamaFit): FitProcessOutcome;
