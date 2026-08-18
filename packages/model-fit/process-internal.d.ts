import type { FitConfig, FitResult } from './index';
import { type FitProcessRequest, type FitProcessResponse } from './process';
export interface FitProcessOutcome {
    response: FitProcessResponse;
    /** The response already encoded, so a caller never re-serialises it to write it. */
    responseLine: string;
    exitCode: 0 | 1 | 2;
}
export type FitProcessFit = (config: FitConfig) => FitResult;
export declare function parseFitProcessRequest(value: unknown): FitProcessRequest;
export declare function encodeFitProcessResponse(response: FitProcessResponse): string;
export declare function runFitProcessLine(line: string, fit: FitProcessFit): FitProcessOutcome;
