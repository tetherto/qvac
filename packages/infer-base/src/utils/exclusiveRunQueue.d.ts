/**
 * Creates a serialized execution queue. Calls to the returned function
 * are guaranteed to run one at a time, in order, even when fired concurrently.
 */
declare function exclusiveRunQueue(): (fn: () => Promise<any>) => Promise<any>;
export = exclusiveRunQueue;
