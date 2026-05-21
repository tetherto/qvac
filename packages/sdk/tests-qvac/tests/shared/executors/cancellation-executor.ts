import {
  cancel,
  completion,
  type CompletionEvent,
  type CompletionRun,
  deleteCache,
  embed,
  InferenceCancelledError,
  ragDeleteWorkspace,
  ragIngest,
  RequestRejectedByPolicyError,
  SDK_SERVER_ERROR_CODES,
  transcribe,
  translate,
} from "@qvac/sdk";
import {
  type Expectation,
  type TestResult,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import {
  cancelBeforeBeginCompletion,
  cancelBroadEmbeddings,
  cancelBroadTranslateLlm,
  cancelByRequestIdEmbed,
  cancelByRequestIdRagIngest,
  cancelMidStreamCompletion,
  cancelThenResumeKvCache,
  policyRejectConcurrentCompletion,
} from "../../cancellation-tests.js";

export type CancelForm = "broad" | "requestId";
type StopReason = "stop" | "length" | "cancelled" | "error";

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

interface EmbedParams {
  passageCount: number;
  passageFiller: string;
  passageFillerRepeats: number;
  registryBeginGraceMs: number;
}

interface TranslateLlmParams {
  text: string;
  from: string;
  to: string;
  maxTokensAfterCancel: number;
}

interface PolicyParams {
  prompt: string;
}

interface RagIngestParams {
  workspaceBase: string;
  documentFiller: string;
  documentFillerRepeats: number;
  chunkSize: number;
  chunkOverlap: number;
  registryBeginGraceMs: number;
}

export interface TranscribeCancelParams {
  audioFileName: string;
}

const INFERENCE_CANCELLED_CODE = SDK_SERVER_ERROR_CODES.INFERENCE_CANCELLED;
const REQUEST_REJECTED_BY_POLICY_CODE =
  SDK_SERVER_ERROR_CODES.REQUEST_REJECTED_BY_POLICY;
// Hardcoded: @qvac/rag is not import-compatible with this consumer runtime.
const RAG_OPERATION_CANCELLED_CODE = 14016;
const ADDON_CANCEL_MESSAGE = "Job cancelled";
// Embed addon surfaces this when llama_decode is aborted mid-flight.
const EMBED_ABORTED_MESSAGE = "Failed to get sequence embeddings";

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// No-op catch so an early rejection doesn't crash the consumer pre-await.
export function markHandled<P extends Promise<unknown>>(p: P): P {
  p.catch(() => {});
  return p;
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

// Object wrapper so TS narrows error state across closure boundaries.
type ErrorSlot = { error: Error | null };
const errorSlot = (): ErrorSlot => ({ error: null });

function errorCode(err: Error): number | undefined {
  return "code" in err && typeof err.code === "number" ? err.code : undefined;
}

export function isCancellationError(err: Error): boolean {
  if (err instanceof InferenceCancelledError) return true;
  const code = errorCode(err);
  if (code === INFERENCE_CANCELLED_CODE || code === RAG_OPERATION_CANCELLED_CODE) {
    return true;
  }
  if (err.name === "INFERENCE_CANCELLED" || err.name === "OPERATION_CANCELLED") {
    return true;
  }
  return (
    err.message === ADDON_CANCEL_MESSAGE ||
    err.message === EMBED_ABORTED_MESSAGE
  );
}

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = errorCode(err);
    return `${err.constructor.name}(code=${code ?? "-"}, name=${err.name}, message=${err.message})`;
  }
  return `non-Error: ${String(err)}`;
}

interface StreamObservation {
  totalEvents: number;
  contentEvents: number;
  accumulatedText: string;
  lastEventType: CompletionEvent["type"] | null;
  lastStopReason: StopReason | null;
}

// Drains a completion stream; optional callback fires after each contentDelta.
async function observeStream(
  events: AsyncIterable<CompletionEvent>,
  onContentDelta?: (count: number, accumulated: string) => Promise<void> | void,
): Promise<StreamObservation> {
  const obs: StreamObservation = {
    totalEvents: 0,
    contentEvents: 0,
    accumulatedText: "",
    lastEventType: null,
    lastStopReason: null,
  };
  for await (const event of events) {
    obs.totalEvents++;
    obs.lastEventType = event.type;
    if (event.type === "contentDelta") {
      obs.contentEvents++;
      obs.accumulatedText += event.text;
      if (onContentDelta) {
        await onContentDelta(obs.contentEvents, obs.accumulatedText);
      }
    } else if (event.type === "completionDone") {
      obs.lastStopReason = (event.stopReason ?? null) as StopReason | null;
    }
  }
  return obs;
}

interface FinalOutcome {
  resolved: boolean;
  error: unknown;
}

async function captureFinal(p: Promise<unknown>): Promise<FinalOutcome> {
  try {
    await p;
    return { resolved: true, error: null };
  } catch (err) {
    return { resolved: false, error: err };
  }
}

// Verifies the cancel error's partial.text and requestId match the wire.
function checkPartialMatch(
  err: InferenceCancelledError,
  expectedText: string,
  expectedRequestId: string,
  label: string,
): TestResult | null {
  const partial = err.partial.text ?? "";
  if (partial !== expectedText) {
    return {
      passed: false,
      output:
        `${label}: partial.text (len=${partial.length}, ${JSON.stringify(partial.slice(0, 80))}) ` +
        `did not match accumulated contentDelta (len=${expectedText.length}, ${JSON.stringify(expectedText.slice(0, 80))})`,
    };
  }
  if (err.requestId !== expectedRequestId) {
    return {
      passed: false,
      output: `${label}: requestId mismatch error=${err.requestId} run=${expectedRequestId}`,
    };
  }
  return null;
}

// Outcome must reject with InferenceCancelledError matching observed wire state.
function checkCancelledFinal(
  outcome: FinalOutcome,
  expectedText: string,
  expectedRequestId: string,
  label: string,
): TestResult | null {
  if (outcome.resolved) {
    return {
      passed: false,
      output: `${label}: run.final resolved instead of rejecting with InferenceCancelledError`,
    };
  }
  if (!(outcome.error instanceof InferenceCancelledError)) {
    return {
      passed: false,
      output: `${label}: rejected with ${describeError(outcome.error)}, expected InferenceCancelledError`,
    };
  }
  return checkPartialMatch(outcome.error, expectedText, expectedRequestId, label);
}

type MidStreamSuccess = {
  ok: true;
  obs: StreamObservation;
  finalError: InferenceCancelledError;
};
type MidStreamFailure = { ok: false; fail: TestResult };

// Streams a completion, cancels after N deltas, validates common invariants.
// Caller adds modality-specific follow-up checks.
async function streamAndCancelAtN(
  run: CompletionRun,
  cancelAfterTokens: number,
): Promise<MidStreamSuccess | MidStreamFailure> {
  let cancelInvoked = false;
  const cancelSlot = errorSlot();

  const obs = await observeStream(run.events, async (count) => {
    if (!cancelInvoked && count >= cancelAfterTokens) {
      cancelInvoked = true;
      try {
        await cancel({ requestId: run.requestId });
      } catch (err) {
        cancelSlot.error = toError(err);
      }
    }
  });

  const finalOutcome = await captureFinal(run.final);

  if (cancelSlot.error) {
    return {
      ok: false,
      fail: {
        passed: false,
        output: `cancel({ requestId }) rejected mid-stream: ${cancelSlot.error.message}`,
      },
    };
  }
  if (!cancelInvoked) {
    return {
      ok: false,
      fail: {
        passed: false,
        output: `Stream ended before ${cancelAfterTokens} contentDelta events arrived (saw ${obs.totalEvents})`,
      },
    };
  }
  if (obs.lastStopReason !== "cancelled") {
    return {
      ok: false,
      fail: {
        passed: false,
        output: `Expected completionDone.stopReason === "cancelled", got ${JSON.stringify(obs.lastStopReason)}`,
      },
    };
  }
  if (!(finalOutcome.error instanceof InferenceCancelledError)) {
    return {
      ok: false,
      fail: {
        passed: false,
        output: `run.final did not reject with InferenceCancelledError: ${describeError(finalOutcome.error)}`,
      },
    };
  }

  return { ok: true, obs, finalError: finalOutcome.error };
}

// Validates the shape of a RequestRejectedByPolicyError for completion.
function checkPolicyError(err: unknown, modelId: string): TestResult | null {
  if (!(err instanceof RequestRejectedByPolicyError)) {
    return {
      passed: false,
      output: `Second completion rejected with ${describeError(err)}, expected RequestRejectedByPolicyError`,
    };
  }
  if (err.modelId !== modelId) {
    return {
      passed: false,
      output: `RequestRejectedByPolicyError.modelId=${JSON.stringify(err.modelId)}, expected ${JSON.stringify(modelId)}`,
    };
  }
  if (err.kind !== "completion") {
    return {
      passed: false,
      output: `RequestRejectedByPolicyError.kind=${JSON.stringify(err.kind)}, expected "completion"`,
    };
  }
  if (!err.reason) {
    return { passed: false, output: "RequestRejectedByPolicyError.reason was empty" };
  }
  if (err.code !== REQUEST_REJECTED_BY_POLICY_CODE) {
    return {
      passed: false,
      output: `RequestRejectedByPolicyError.code=${err.code}, expected ${REQUEST_REJECTED_BY_POLICY_CODE}`,
    };
  }
  return null;
}

const sharedTests = [
  cancelMidStreamCompletion,
  cancelBeforeBeginCompletion,
  cancelThenResumeKvCache,
  cancelBroadEmbeddings,
  cancelBroadTranslateLlm,
  policyRejectConcurrentCompletion,
  cancelByRequestIdEmbed,
  cancelByRequestIdRagIngest,
];

export class CancellationExecutor extends AbstractModelExecutor<
  typeof sharedTests
> {
  pattern = /^(cancel-|policy-reject-)/;

  // `as never` lets subclasses extend handlers with test ids outside TDefs.
  protected handlers = this.buildSharedHandlers() as never;

  protected buildSharedHandlers() {
    return {
      [cancelMidStreamCompletion.testId]: this.cancelMidStream.bind(this),
      [cancelBeforeBeginCompletion.testId]: this.cancelBeforeBegin.bind(this),
      [cancelThenResumeKvCache.testId]: this.cancelThenResumeKvCache.bind(this),
      [cancelBroadEmbeddings.testId]: this.embedBroad.bind(this),
      [cancelByRequestIdEmbed.testId]: this.embedTargeted.bind(this),
      [cancelBroadTranslateLlm.testId]: this.translateLlmBroad.bind(this),
      [policyRejectConcurrentCompletion.testId]: this.policyReject.bind(this),
      [cancelByRequestIdRagIngest.testId]: this.ragIngestTargeted.bind(this),
    };
  }

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

    const result = await streamAndCancelAtN(run, cancelAfterTokens);
    if (!result.ok) return result.fail;

    if (result.obs.lastEventType !== "completionDone") {
      return {
        passed: false,
        output: `Expected last event to be completionDone, got ${result.obs.lastEventType} after ${result.obs.totalEvents} events`,
      };
    }

    const partialFail = checkPartialMatch(
      result.finalError,
      result.obs.accumulatedText,
      run.requestId,
      "cancelMidStream",
    );
    if (partialFail) return partialFail;

    return {
      passed: true,
      output:
        `Mid-stream cancel OK: events=${result.obs.totalEvents}, stopReason=cancelled, ` +
        `partial.text length=${result.obs.accumulatedText.length}`,
    };
  }

  async cancelBeforeBegin(
    params: CancelBeforeBeginParams,
    _expectation: Expectation,
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded("llm");

    const run = completion({
      modelId,
      history: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: params.prompt },
      ],
      stream: true,
    });

    // Sync cancel after completion() — registry replays it retroactively
    // whether it arrives before or after server-side begin().
    const cancelSlot = errorSlot();
    const cancelTask = cancel({ requestId: run.requestId }).catch((err) => {
      cancelSlot.error = toError(err);
    });

    const obs = await observeStream(run.events);
    await cancelTask;

    if (cancelSlot.error) {
      return {
        passed: false,
        output: `cancel({ requestId }) rejected for an unknown id: ${cancelSlot.error.message}`,
      };
    }
    if (obs.lastEventType !== "completionDone") {
      return {
        passed: false,
        output: `Expected last event to be completionDone, got ${obs.lastEventType} (events=${obs.totalEvents}, content=${obs.contentEvents})`,
      };
    }
    if (obs.lastStopReason !== "cancelled") {
      return {
        passed: false,
        output:
          `Expected stopReason "cancelled" (cancel-before-begin replayed retroactively), ` +
          `got ${JSON.stringify(obs.lastStopReason)} (events=${obs.totalEvents}, content=${obs.contentEvents})`,
      };
    }

    const finalFail = checkCancelledFinal(
      await captureFinal(run.final),
      obs.accumulatedText,
      run.requestId,
      "cancelBeforeBegin",
    );
    if (finalFail) return finalFail;

    return {
      passed: true,
      output:
        `Cancel-before-begin OK: events=${obs.totalEvents}, content=${obs.contentEvents}, ` +
        `partial.text length=${obs.accumulatedText.length}`,
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
        // First run owns this cache key — missing-file errors are fine.
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

      // First turn must cancel cleanly so kv-cache rollback runs
      // before the second turn reuses the same cache key.
      const firstResult = await streamAndCancelAtN(firstRun, cancelAfterTokens);
      if (!firstResult.ok) return firstResult.fail;

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
            "Second completion returned an empty response after cancelling the previous " +
            "streaming turn — rollback likely left stale state in the KvCacheSession.",
        };
      }

      const expected = params.expectedAnswerContains;
      if (!trimmed.toLowerCase().includes(expected.toLowerCase())) {
        return {
          passed: false,
          output:
            `Second completion did not include expected token ${JSON.stringify(expected)}. ` +
            `Got ${secondText.length} chars: ${JSON.stringify(secondText.slice(0, 200))}`,
        };
      }

      return {
        passed: true,
        output:
          `Cancel-then-resume KV-cache OK: cancelled after ${firstResult.obs.contentEvents} tokens, ` +
          `second turn produced ${secondText.length} chars containing ${JSON.stringify(expected)}`,
      };
    } catch (error) {
      return {
        passed: false,
        output: `Cancel-then-resume KV-cache failed: ${describeError(error)}`,
      };
    }
  }

  async embedBroad(
    params: EmbedParams,
    _expectation: Expectation,
  ): Promise<TestResult> {
    return this.embedRun(params, "broad");
  }

  async embedTargeted(
    params: EmbedParams,
    _expectation: Expectation,
  ): Promise<TestResult> {
    return this.embedRun(params, "requestId");
  }

  private async embedRun(
    params: EmbedParams,
    cancelForm: CancelForm,
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded("embeddings");
    const op = markHandled(embed({ modelId, text: this.buildPassages(params) }));
    // Unary op — sleep so the server registers the request before cancel.
    await sleep(params.registryBeginGraceMs);
    if (cancelForm === "broad") {
      await cancel({ operation: "embeddings", modelId });
    } else {
      await cancel({ requestId: op.requestId });
    }
    return this.assertCancelled(op, "embed", cancelForm);
  }

  private buildPassages(params: EmbedParams): string[] {
    return Array.from(
      { length: params.passageCount },
      (_, i) =>
        `Passage ${i + 1}. ${params.passageFiller.repeat(params.passageFillerRepeats)}`,
    );
  }

  private async assertCancelled(
    op: Promise<unknown>,
    label: string,
    cancelForm: CancelForm,
  ): Promise<TestResult> {
    try {
      await op;
      return {
        passed: false,
        output: `${label} resolved after cancel(${cancelForm}) — addon was not interrupted`,
      };
    } catch (err) {
      if (!(err instanceof Error)) {
        return {
          passed: false,
          output: `${label} rejected with ${describeError(err)}`,
        };
      }
      if (!isCancellationError(err)) {
        return {
          passed: false,
          output: `${label} rejected with ${describeError(err)}, expected a cancellation error`,
        };
      }
      return {
        passed: true,
        output: `${label} cancel(${cancelForm}) OK: ${describeError(err)}`,
      };
    }
  }

  async translateLlmBroad(
    params: TranslateLlmParams,
    _expectation: Expectation,
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded("llm");
    const result = translate({
      modelId,
      text: params.text,
      from: params.from,
      to: params.to,
      modelType: "llm",
      stream: true,
    });

    let received = 0;
    let cancelInvoked = false;
    const cancelSlot = errorSlot();

    try {
      for await (const _token of result.tokenStream) {
        received++;
        if (!cancelInvoked) {
          cancelInvoked = true;
          // First token proves the addon is decoding — cancel then.
          void cancel({ modelId, kind: "translate" }).catch((err: unknown) => {
            cancelSlot.error = toError(err);
          });
        }
      }
    } catch (err) {
      return {
        passed: false,
        output: `translate(llm) stream threw mid-iteration: ${describeError(err)}`,
      };
    }

    if (cancelSlot.error) {
      return {
        passed: false,
        output: `cancel({ modelId, kind }) rejected: ${cancelSlot.error.message}`,
      };
    }
    if (!cancelInvoked) {
      return {
        passed: false,
        output: "translate(llm) stream ended before any token — cancel never fired",
      };
    }
    if (received > params.maxTokensAfterCancel) {
      return {
        passed: false,
        output: `translate(llm) yielded ${received} tokens after cancel (allowed ≤ ${params.maxTokensAfterCancel})`,
      };
    }
    return {
      passed: true,
      output: `translate(llm) broad cancel OK: ${received} tokens before stream end (≤ ${params.maxTokensAfterCancel})`,
    };
  }

  async policyReject(
    params: PolicyParams,
    _expectation: Expectation,
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded("llm");
    const history = [
      { role: "system" as const, content: "You are a helpful assistant." },
      { role: "user" as const, content: params.prompt },
    ];

    const run1 = completion({ modelId, history, stream: true });
    const run1EventsIter = run1.events[Symbol.asyncIterator]();
    const final1 = markHandled(run1.final);
    let firstEventConsumed = false;

    try {
      // Wait for run1's first contentDelta so the registry holds the
      // entry and the policy will reject the concurrent run2.
      while (!firstEventConsumed) {
        const next = await run1EventsIter.next();
        if (next.done) {
          return {
            passed: false,
            output: "run1 stream ended before any contentDelta — cannot establish policy precondition",
          };
        }
        if (next.value.type === "contentDelta") {
          firstEventConsumed = true;
        }
      }

      const run2 = completion({ modelId, history, stream: true });
      markHandled(run2.text);
      markHandled(run2.toolCalls);
      markHandled(run2.stats);

      const finalOutcome = await captureFinal(run2.final);
      if (finalOutcome.resolved) {
        return {
          passed: false,
          output: "Second completion resolved — oneAtATimePerModel policy did not reject",
        };
      }
      const policyFail = checkPolicyError(finalOutcome.error, modelId);
      if (policyFail) return policyFail;
      const policyErr = finalOutcome.error as RequestRejectedByPolicyError;
      return {
        passed: true,
        output: `Policy reject OK: ${describeError(policyErr)} reason=${JSON.stringify(policyErr.reason.slice(0, 80))}`,
      };
    } finally {
      try {
        await cancel({ requestId: run1.requestId });
      } catch {
        // run1 may have ended already — cleanup is best-effort.
      }
      // Drain stream + final so run1 fully settles before we return.
      try {
        while (!(await run1EventsIter.next()).done) {}
      } catch {}
      try {
        await final1;
      } catch {}
    }
  }

  async ragIngestTargeted(
    params: RagIngestParams,
    _expectation: Expectation,
  ): Promise<TestResult> {
    const embeddingModelId = await this.resources.ensureLoaded("embeddings");
    const workspace = `${params.workspaceBase}-${embeddingModelId.substring(0, 8)}`;

    await this.safeDeleteWorkspace(workspace);

    const document = params.documentFiller.repeat(params.documentFillerRepeats);
    const op = markHandled(
      ragIngest({
        modelId: embeddingModelId,
        workspace,
        documents: [document],
        chunk: true,
        chunkOpts: {
          chunkSize: params.chunkSize,
          chunkOverlap: params.chunkOverlap,
          chunkStrategy: "character",
        },
      }),
    );

    try {
      // Unary op without observable progress — sleep covers registry begin.
      await sleep(params.registryBeginGraceMs);
      try {
        await cancel({ requestId: op.requestId });
      } catch (err) {
        return {
          passed: false,
          output: `cancel({ requestId }) for ragIngest rejected: ${describeError(err)}`,
        };
      }
      return await this.assertCancelled(op, "ragIngest", "requestId");
    } finally {
      await this.safeDeleteWorkspace(workspace);
    }
  }

  private async safeDeleteWorkspace(workspace: string): Promise<void> {
    try {
      await ragDeleteWorkspace({ workspace });
    } catch {
      // workspace may not exist yet or be mid-flight; either case is harmless
    }
  }

  // Fire cancel synchronously after transcribe() so it races begin() at
  // the registry. Two valid cancellation outcomes are accepted:
  //   - rejection with a cancellation error (addon aborted mid-decode);
  //   - empty result (server's iterate loop broke on signal.aborted
  //     before yielding any segment).
  // Non-empty result means cancel was too late.
  protected async transcribeWithCancel(audioPath: string): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded("whisper");
    const op = markHandled(transcribe({ modelId, audioChunk: audioPath }));
    const startMs = Date.now();

    const cancelSlot = errorSlot();
    const cancelTask = cancel({ requestId: op.requestId }).catch((err) => {
      cancelSlot.error = toError(err);
    });

    try {
      const text = await op;
      await cancelTask;
      const elapsedMs = Date.now() - startMs;
      if (cancelSlot.error) {
        return {
          passed: false,
          output: `cancel({ requestId }) for transcribe rejected: ${cancelSlot.error.message}`,
        };
      }
      if (text.length === 0) {
        return {
          passed: true,
          output: `transcribe cancel({ requestId }) OK: empty result after cancel (elapsed=${elapsedMs}ms)`,
        };
      }
      return {
        passed: false,
        output: `transcribe resolved with ${text.length} chars after cancel({ requestId }) (elapsed=${elapsedMs}ms) — cancel was too late to interrupt the operation`,
      };
    } catch (err) {
      await cancelTask;
      const elapsedMs = Date.now() - startMs;
      if (cancelSlot.error) {
        return {
          passed: false,
          output: `cancel({ requestId }) for transcribe rejected: ${cancelSlot.error.message}`,
        };
      }
      if (err instanceof Error && isCancellationError(err)) {
        return {
          passed: true,
          output: `transcribe cancel({ requestId }) OK: ${describeError(err)} (elapsed=${elapsedMs}ms)`,
        };
      }
      return {
        passed: false,
        output: `transcribe rejected with non-cancellation error: ${describeError(err)}`,
      };
    }
  }
}
