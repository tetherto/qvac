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
/**
 * Absolute path to the one-shot runner, to be spawned with a Bare executable.
 *
 * The child reads one request line on stdin and writes one response line on
 * stdout. Supervisors must key off that line rather than the exit code, and are
 * responsible for the deadline the runner does not impose: see "What the parent
 * observes" in the package README for the full set of outcomes.
 *
 * Resolved on demand so hosts without subprocess support can import the
 * protocol and refuse the feature before the runner entrypoint is looked up.
 */
export declare function resolveFitProcessRunnerPath(): string;
