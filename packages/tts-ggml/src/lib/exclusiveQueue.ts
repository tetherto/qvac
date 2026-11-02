/**
 * Exclusive execution (`exclusiveRun: true`): plain runs go through
 * infer-base's serialized queue, and streaming responses line up behind the
 * previous response until it has settled.
 */
import { exclusiveRunQueue } from "@qvac/infer-base";

export type ExclusiveRunner = <T>(fn: () => Promise<T>) => Promise<T>;

/** What `run()` goes through: one at a time under `exclusiveRun`, at once otherwise. */
export function resolveExclusiveRunner(exclusiveRun: boolean): ExclusiveRunner {
  if (exclusiveRun) return exclusiveRunQueue();
  return async function runNow<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  };
}

interface SettlingResponse {
  await(): Promise<unknown>;
}

/**
 * Serializes streaming responses. `enqueue` resolves with the new response
 * once every earlier one has settled; a `run` that throws releases its slot
 * at once so the next stream is not held up.
 */
export class ExclusiveResponseQueue {
  private waiter: Promise<void> = Promise.resolve();

  async enqueue<T extends SettlingResponse>(run: () => T): Promise<T> {
    const previous = this.waiter;
    let releaseSlot: () => void = () => {};
    this.waiter = new Promise<void>((resolve) => {
      releaseSlot = resolve;
    });
    await previous;
    let response: T;
    try {
      response = run();
    } catch (error) {
      releaseSlot();
      throw error;
    }
    void response.await().finally(releaseSlot).catch(() => {});
    return response;
  }
}
