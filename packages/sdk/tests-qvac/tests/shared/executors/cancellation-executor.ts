import {
  cancel,
  completion,
  deleteCache,
  InferenceCancelledError,
} from "@qvac/sdk";
import {
  type Expectation,
  type TestResult,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import { cancellationTests } from "../../cancellation-tests.js";

interface MidStreamParams {
  prompt: string;
  cancelAfterTokens?: number;
}

interface CancelBeforeBeginParams {
  prompt: string;
}

interface CancelThenResumeKvCacheParams {
  cacheKey: string;
  firstUserMessage: string;
  secondUserMessage: string;
  expectedAnswerContains: string;
  cancelAfterTokens?: number;
}

export class CancellationExecutor extends AbstractModelExecutor<
  typeof cancellationTests
> {
  pattern = /^cancel-(mid-stream-completion|before-begin-completion|then-resume-kv-cache)$/;

  protected handlers = Object.fromEntries(
    cancellationTests.map((test) => {
      if (test.testId === "cancel-mid-stream-completion") {
        return [test.testId, this.cancelMidStream.bind(this)];
      }
      if (test.testId === "cancel-before-begin-completion") {
        return [test.testId, this.cancelBeforeBegin.bind(this)];
      }
      if (test.testId === "cancel-then-resume-kv-cache") {
        return [test.testId, this.cancelThenResumeKvCache.bind(this)];
      }
      return [test.testId, this.cancelMidStream.bind(this)];
    }),
  ) as never;

  async cancelMidStream(
    params: MidStreamParams,
    _expectation: Expectation,
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded("llm");
    const cancelAfterTokens = params.cancelAfterTokens ?? 3;

    const run = completion({
      modelId,
      history: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: params.prompt },
      ],
      stream: true,
    });

    // Concurrently accumulate contentDelta text from `run.events`. This
    // is the "source of truth" the SDK's aggregator builds `partial.text`
    // from — equality between this and the rejected promise's
    // `.partial.text` is the cancellation contract under test.
    let accumulatedText = "";
    let lastEventType: string | null = null;
    let lastStopReason: string | null = null;
    let eventsCount = 0;
    let cancelInvoked = false;
    // Object container so TS keeps `Error | null` across the closure.
    const cancelState: { error: Error | null } = { error: null };

    const eventsTask = (async () => {
      for await (const event of run.events) {
        eventsCount++;
        lastEventType = event.type;
        if (event.type === "contentDelta") {
          accumulatedText += event.text;
          if (!cancelInvoked && eventsCount >= cancelAfterTokens) {
            cancelInvoked = true;
            try {
              await cancel({ requestId: run.requestId });
            } catch (err) {
              cancelState.error =
                err instanceof Error ? err : new Error(String(err));
            }
          }
        } else if (event.type === "completionDone") {
          lastStopReason = event.stopReason ?? null;
        }
      }
    })();

    let finalError: unknown = null;
    let finalResolved = false;
    try {
      await run.final;
      finalResolved = true;
    } catch (err) {
      finalError = err;
    }

    await eventsTask;

    if (cancelState.error) {
      return {
        passed: false,
        output: `cancel({ requestId }) rejected mid-stream: ${cancelState.error.message}`,
      };
    }

    if (!cancelInvoked) {
      return {
        passed: false,
        output: `Stream ended before ${cancelAfterTokens} contentDelta events arrived (only ${eventsCount} events seen) — cancel was never fired`,
      };
    }

    // (a) The `events` stream must terminate normally with a
    // `completionDone` event carrying `stopReason: "cancelled"`. The
    // server still flushes a terminal event when the registry signal
    // aborts so consumers iterating `run.events` exit naturally.
    if (lastEventType !== "completionDone") {
      return {
        passed: false,
        output: `Expected last event to be completionDone, got ${lastEventType} after ${eventsCount} events`,
      };
    }
    if (lastStopReason !== "cancelled") {
      return {
        passed: false,
        output: `Expected completionDone.stopReason === "cancelled", got ${JSON.stringify(lastStopReason)}`,
      };
    }

    // (b) `run.final` must reject with InferenceCancelledError.
    if (finalResolved) {
      return {
        passed: false,
        output: "run.final resolved instead of rejecting with InferenceCancelledError",
      };
    }
    if (!(finalError instanceof InferenceCancelledError)) {
      const msg = finalError instanceof Error ? finalError.message : String(finalError);
      const ctor =
        finalError && typeof finalError === "object"
          ? (finalError.constructor as { name?: string }).name ?? "unknown"
          : typeof finalError;
      return {
        passed: false,
        output: `run.final rejected with ${ctor}, expected InferenceCancelledError: ${msg}`,
      };
    }

    // (c) `error.partial.text` must equal the concatenated
    // `contentDelta` text we observed on the events stream. The
    // SDK always populates `partial.text` for cancelled completions
    // (even an empty string), but the schema marks it optional so we
    // default to `""` here for the comparison.
    const partialText = finalError.partial.text ?? "";
    if (partialText !== accumulatedText) {
      return {
        passed: false,
        output:
          `InferenceCancelledError.partial.text (${JSON.stringify(
            partialText.slice(0, 80),
          )}, len=${partialText.length}) did not match ` +
          `concatenated contentDelta text (${JSON.stringify(
            accumulatedText.slice(0, 80),
          )}, len=${accumulatedText.length})`,
      };
    }

    if (finalError.requestId !== run.requestId) {
      return {
        passed: false,
        output: `InferenceCancelledError.requestId mismatch: error=${finalError.requestId}, run=${run.requestId}`,
      };
    }

    return {
      passed: true,
      output:
        `Mid-stream cancel OK: events=${eventsCount}, stopReason=cancelled, ` +
        `partial.text length=${partialText.length} (matches concatenated contentDelta)`,
    };
  }

  async cancelBeforeBegin(
    params: CancelBeforeBeginParams,
    _expectation: Expectation,
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded("llm");

    // Construct the run synchronously and fire the cancel on the very
    // next turn, before awaiting anything from the run. The client-side
    // `requestId` is generated before any RPC round-trip, so the cancel
    // RPC can land while the server has not yet seen the
    // `completionStream` request — or with `bare-rpc`'s request
    // multiplexing, even slightly after begin() ran. The bounded
    // cancelled-before-begin map handles both orderings: the eventual
    // outcome is always a typed `cancelled` result on the wire.
    const run = completion({
      modelId,
      history: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: params.prompt },
      ],
      stream: true,
    });

    // Synchronous cancel-fire. We do NOT await the original `completion(...)`
    // RPC settling before issuing this — that's the whole point of the
    // racy code path.
    // Object container so TS keeps `Error | null` across the .catch closure.
    const cancelState: { error: Error | null } = { error: null };
    const cancelTask = cancel({ requestId: run.requestId }).catch((err) => {
      cancelState.error =
        err instanceof Error ? err : new Error(String(err));
    });

    let lastEventType: string | null = null;
    let lastStopReason: string | null = null;
    let contentEvents = 0;
    let totalEvents = 0;
    let accumulatedText = "";
    for await (const event of run.events) {
      totalEvents++;
      lastEventType = event.type;
      if (event.type === "contentDelta") {
        contentEvents++;
        accumulatedText += event.text;
      } else if (event.type === "completionDone") {
        lastStopReason = event.stopReason ?? null;
      }
    }

    await cancelTask;

    if (cancelState.error) {
      return {
        passed: false,
        output: `cancel({ requestId }) rejected for an unknown id: ${cancelState.error.message}`,
      };
    }

    if (lastEventType !== "completionDone") {
      return {
        passed: false,
        output: `Expected last event to be completionDone, got ${lastEventType}. totalEvents=${totalEvents}, contentEvents=${contentEvents}`,
      };
    }

    // Contract: the eventual outcome is a typed `cancelled` result,
    // regardless of whether the cancel landed before or after begin()
    // ran on the server.
    if (lastStopReason !== "cancelled") {
      return {
        passed: false,
        output:
          `Expected stopReason "cancelled" (cancel-before-begin replayed retroactively), ` +
          `got ${JSON.stringify(lastStopReason)}. ` +
          `totalEvents=${totalEvents}, contentEvents=${contentEvents}`,
      };
    }

    let finalRejected: unknown = null;
    try {
      await run.final;
      return {
        passed: false,
        output: "run.final resolved instead of rejecting after cancel-before-begin",
      };
    } catch (err) {
      finalRejected = err;
    }

    if (!(finalRejected instanceof InferenceCancelledError)) {
      const msg =
        finalRejected instanceof Error
          ? finalRejected.message
          : String(finalRejected);
      return {
        passed: false,
        output: `Expected run.final to reject with InferenceCancelledError, got: ${msg}`,
      };
    }

    if (finalRejected.requestId !== run.requestId) {
      return {
        passed: false,
        output: `InferenceCancelledError.requestId mismatch: error=${finalRejected.requestId}, run=${run.requestId}`,
      };
    }

    return {
      passed: true,
      output:
        `Cancel-before-begin OK: totalEvents=${totalEvents}, contentEvents=${contentEvents}, ` +
        `partial.text length=${accumulatedText.length}, stopReason=cancelled, ` +
        `final rejected with InferenceCancelledError`,
    };
  }

  async cancelThenResumeKvCache(
    params: CancelThenResumeKvCacheParams,
    _expectation: Expectation,
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded("llm");
    const cancelAfterTokens = params.cancelAfterTokens ?? 3;

    try {
      try {
        await deleteCache({ kvCacheKey: params.cacheKey });
      } catch {
        // ignore ENOENT — the test owns the cache key
      }

      const firstRun = completion({
        modelId,
        history: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: params.firstUserMessage },
        ],
        stream: true,
        kvCache: params.cacheKey,
      });

      let receivedTokens = 0;
      let firstCancelInvoked = false;
      let firstCancelError: Error | null = null;
      let firstStopReason: string | null = null;

      for await (const event of firstRun.events) {
        if (event.type === "contentDelta") {
          receivedTokens++;
          if (!firstCancelInvoked && receivedTokens >= cancelAfterTokens) {
            firstCancelInvoked = true;
            try {
              await cancel({ requestId: firstRun.requestId });
            } catch (err) {
              firstCancelError =
                err instanceof Error ? err : new Error(String(err));
              break;
            }
          }
        } else if (event.type === "completionDone") {
          firstStopReason = event.stopReason ?? null;
        }
      }

      if (firstCancelError) {
        return {
          passed: false,
          output: `cancel({ requestId }) on first turn rejected: ${firstCancelError.message}`,
        };
      }
      if (!firstCancelInvoked) {
        return {
          passed: false,
          output: `First completion ended before cancel (received ${receivedTokens} tokens, expected >=${cancelAfterTokens})`,
        };
      }

      // Drain `final` so the run is fully settled before issuing the
      // second turn. KvCacheSession.rollback runs inside the
      // scope.defer chain, which is triggered when the response
      // generator exits; we need that to have happened before turn 2.
      let firstRejected: unknown = null;
      try {
        await firstRun.final;
      } catch (err) {
        firstRejected = err;
      }
      if (!(firstRejected instanceof InferenceCancelledError)) {
        const msg =
          firstRejected instanceof Error
            ? firstRejected.message
            : String(firstRejected);
        return {
          passed: false,
          output: `First turn did not reject with InferenceCancelledError: ${msg}`,
        };
      }
      if (firstStopReason !== "cancelled") {
        return {
          passed: false,
          output: `Expected first completionDone.stopReason === "cancelled", got ${JSON.stringify(firstStopReason)}`,
        };
      }

      // KvCacheSession.rollback should have wiped the in-memory message
      // counter, the initialized-cache flag, and the on-disk .bin —
      // the second turn must therefore re-prime cleanly and produce a
      // correct answer for an unrelated prompt.
      const secondRun = completion({
        modelId,
        history: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: params.secondUserMessage },
        ],
        stream: true,
        kvCache: params.cacheKey,
      });

      let secondText = "";
      for await (const token of secondRun.tokenStream) {
        secondText += token;
      }

      const trimmed = secondText.trim();
      if (trimmed.length === 0) {
        return {
          passed: false,
          output:
            "Second completion on the same kvCache key returned an empty response " +
            "after cancelling the previous streaming turn. Rollback likely left " +
            "stale state in the KvCacheSession.",
        };
      }

      const expected = params.expectedAnswerContains;
      if (!trimmed.toLowerCase().includes(expected.toLowerCase())) {
        return {
          passed: false,
          output:
            `Second completion did not include expected token ${JSON.stringify(expected)} ` +
            `after cancelling the previous turn. Got ${secondText.length} chars: ` +
            `${JSON.stringify(secondText.slice(0, 200))}`,
        };
      }

      return {
        passed: true,
        output:
          `Cancel-then-resume KV-cache OK: cancelled after ${receivedTokens} tokens, ` +
          `first turn rejected with InferenceCancelledError, second turn produced ` +
          `${secondText.length} chars containing ${JSON.stringify(expected)}`,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        passed: false,
        output: `Cancel-then-resume KV-cache failed: ${errorMsg}`,
      };
    }
  }
}
