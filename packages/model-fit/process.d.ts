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
 * stdout: exit 0 with a `completed` line, exit 1 when the fit call threw, exit
 * 2 when the request never reached the fitter. A native abort produces no line
 * at all, so a supervisor must key off the line rather than the exit code — a
 * parent that has closed its read end gets exit 0 and no output. The runner
 * imposes no timeout; bounding and cancelling the child is the caller's job.
 *
 * Resolved on demand so hosts without subprocess support can import the
 * protocol and refuse the feature before the runner entrypoint is looked up.
 */
export declare function resolveFitProcessRunnerPath(): string;
