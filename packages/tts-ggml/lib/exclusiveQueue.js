"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExclusiveResponseQueue = void 0;
exports.resolveExclusiveRunner = resolveExclusiveRunner;
/**
 * Exclusive execution (`exclusiveRun: true`): plain runs go through
 * infer-base's serialized queue, and streaming responses line up behind the
 * previous response until it has settled.
 */
const infer_base_1 = require("@qvac/infer-base");
/** What `run()` goes through: one at a time under `exclusiveRun`, at once otherwise. */
function resolveExclusiveRunner(exclusiveRun) {
    if (exclusiveRun)
        return (0, infer_base_1.exclusiveRunQueue)();
    return async function runNow(callback) {
        return callback();
    };
}
/**
 * Serializes streaming responses. `enqueue` resolves with the new response
 * once every earlier one has settled; a `run` that throws releases its slot
 * at once so the next stream is not held up.
 */
class ExclusiveResponseQueue {
    waiter = Promise.resolve();
    async enqueue(run) {
        const previous = this.waiter;
        let releaseSlot = () => { };
        this.waiter = new Promise((resolve) => {
            releaseSlot = resolve;
        });
        await previous;
        let response;
        try {
            response = run();
        }
        catch (error) {
            releaseSlot();
            throw error;
        }
        void response.await().finally(releaseSlot).catch(() => { });
        return response;
    }
}
exports.ExclusiveResponseQueue = ExclusiveResponseQueue;
