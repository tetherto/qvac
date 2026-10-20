export type ExclusiveRunner = <T>(fn: () => Promise<T>) => Promise<T>;
/** What `run()` goes through: one at a time under `exclusiveRun`, at once otherwise. */
export declare function resolveExclusiveRunner(exclusiveRun: boolean): ExclusiveRunner;
interface SettlingResponse {
    await(): Promise<unknown>;
}
/**
 * Serializes streaming responses. `enqueue` resolves with the new response
 * once every earlier one has settled; a `run` that throws releases its slot
 * at once so the next stream is not held up.
 */
export declare class ExclusiveResponseQueue {
    private waiter;
    enqueue<T extends SettlingResponse>(run: () => T): Promise<T>;
}
export {};
