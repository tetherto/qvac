import type { FitConfig, FitResult, LlamaLoadFitConfig } from './index';
import { type FitProcessRequest, type FitProcessResponse } from './process';
export interface FitProcessOutcome {
    response: FitProcessResponse;
    responseLine: string;
    exitCode: 0 | 1 | 2;
}
export type FitProcessFit = (config: FitConfig) => FitResult;
export type FitProcessLlamaFit = (config: LlamaLoadFitConfig) => FitResult;
export declare function parseFitProcessRequest(value: unknown): FitProcessRequest;
export declare function encodeFitProcessResponse(response: FitProcessResponse): string;
export declare function runFitProcessLine(line: string, fit: FitProcessFit, fitLlama?: FitProcessLlamaFit): FitProcessOutcome;
