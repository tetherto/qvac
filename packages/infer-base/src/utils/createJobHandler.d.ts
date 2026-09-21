import QvacResponse = require('../QvacResponse');
interface CreateJobHandlerOptions {
    cancel: () => void | Promise<void>;
}
interface JobHandler {
    start(runOpts?: {
        signal?: QvacResponse.AbortSignalLike;
    }): QvacResponse;
    startWith(response: QvacResponse): QvacResponse;
    output(data: any): void;
    end(stats?: any, result?: any): void;
    fail(error: Error | string): void;
    readonly active: QvacResponse | null;
}
/**
 * Creates a single-job handler that manages the lifecycle of a QvacResponse.
 * Replaces the _jobToResponse Map / _saveJobToResponseMapping / _deleteJobMapping
 * boilerplate used by every addon.
 */
declare function createJobHandler(opts: CreateJobHandlerOptions): JobHandler;
export = createJobHandler;
