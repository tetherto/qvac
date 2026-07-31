import QvacResponse = require('./src/QvacResponse');
import exclusiveRunQueue = require('./src/utils/exclusiveRunQueue');
import getApiDefinition = require('./src/utils/getApiDefinition');
export type AbortSignalLike = QvacResponse.AbortSignalLike;
export interface JobHandler {
    /**
     * Creates a new QvacResponse and stores it as active. Fails any stale active response.
     * Optionally accepts an abort signal forwarded into the response — typically the per-call
     * signal the addon received from `model.run(input, { signal })`. The abort `reason`
     * becomes the response error (passed through unchanged when it's an Error).
     */
    start(runOpts?: {
        signal?: AbortSignalLike;
    }): QvacResponse;
    /** Registers a pre-built response (e.g. a custom subclass) as active. Fails any stale active response. */
    startWith(response: QvacResponse): QvacResponse;
    /** Routes output data to the active response. No-op if idle. */
    output(data: any): void;
    /** Ends the active response. Optionally forwards stats before ending. */
    end(stats?: any, result?: any): void;
    /** Fails the active response with an error. */
    fail(error: Error | string): void;
    /** The current active QvacResponse, or null if idle. */
    readonly active: QvacResponse | null;
}
declare const createJobHandler: (opts: {
    cancel: () => void | Promise<void>;
}) => JobHandler;
export { QvacResponse, createJobHandler, exclusiveRunQueue, getApiDefinition };
