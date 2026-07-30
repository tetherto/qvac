import EventEmitter = require('bare-events');
/**
 * QvacResponse provides an interface for handling asynchronous responses
 * with update notifications, error handling, and more.
 * It extends EventEmitter to allow event-based interaction.
 */
declare class QvacResponse<Output = any> extends EventEmitter {
    protected output: Output[];
    protected stats: any;
    constructor(handlers: {
        cancelHandler: () => Promise<void>;
        /**
         * Optional abort signal. When aborted, the response is failed with
         * the abort `reason` — passed through unchanged when it's an Error,
         * otherwise wrapped in a default `Error('Aborted: ...')`. Wires
         * external timeout / crash into the response without polling. Addons
         * typically forward the signal they received from
         * `model.run(input, { signal })` straight into the response.
         */
        signal?: QvacResponse.AbortSignalLike;
    }, pollInterval?: number);
    /**
     * Registers a callback to be invoked on each output update.
     */
    onUpdate(callback: (data: Output) => void): this;
    /**
     * Registers a callback for when the response finishes.
     * If a callback is provided, it is invoked with the terminal result.
     */
    onFinish(callback?: (result: Output[] | any) => void): this;
    /**
     * Returns a promise that resolves with the terminal result when the response finishes.
     */
    await(): Promise<Output[] | any>;
    /**
     * Registers a callback to be invoked when an error occurs.
     */
    onError(callback: (error: Error) => void): this;
    /**
     * Registers a callback to be invoked when the response is cancelled.
     */
    onCancel(callback: () => void): this;
    /**
     * Adds an output update and emits an 'output' event.
     */
    updateOutput(output: Output): void;
    /**
     * Updates the response statistics and emits a 'stats' event.
     */
    updateStats(stats: any): void;
    /**
     * Marks the response as failed, emits an 'error' event, and rejects the finish promise.
     * Idempotent: no-op once already settled. Detaches the abort-signal listener (if any).
     */
    failed(error: Error): void;
    /**
     * Marks the response as ended, emits an 'end' event, and resolves the finish promise.
     * Idempotent: no-op once already settled. Detaches the abort-signal listener (if any).
     */
    ended(result?: Output[] | any): void;
    /**
     * Returns the most recent output.
     */
    getLatest(): Output | null;
    /**
     * Async generator that yields each output update until the response stops running.
     *
     * Wakes up immediately on output/end/error events instead of polling
     * out the remaining `pollInterval` window. A single pair of EventEmitter
     * listeners is attached for the lifetime of the iterator (not per
     * yielded chunk), so high-frequency token streams don't churn
     * listener registrations.
     */
    iterate(): AsyncIterableIterator<Output>;
    /**
     * Cancels the response by invoking the cancel handler and emitting a 'cancel' event.
     */
    cancel(): Promise<void>;
}
declare namespace QvacResponse {
    /**
     * Structural abort-signal contract covering only the members this package
     * touches, so Bare, DOM, and Node signals are all assignable.
     */
    interface AbortSignalLike {
        readonly aborted: boolean;
        readonly reason?: unknown;
        addEventListener(type: 'abort', listener: () => void, options?: {
            once?: boolean;
        }): void;
        removeEventListener(type: 'abort', listener: () => void): void;
    }
}
export = QvacResponse;
