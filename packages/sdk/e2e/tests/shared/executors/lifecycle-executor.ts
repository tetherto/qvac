import { suspend, resume, state, completion, modelRegistryList, type LifecycleState } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import { AbstractModelExecutor } from "./abstract-model-executor.js";
import {
  lifecycleTests,
  lifecycleSuspendResumeBasic,
  lifecycleSuspendIdempotent,
  lifecycleResumeIdempotent,
  lifecycleSuspendResumeInference,
  lifecycleRapidToggle,
  lifecycleSuspendDuringInference,
  lifecycleStateTransitions,
  lifecycleBlockedCompletion,
  lifecycleBlockedRegistry,
} from "../../lifecycle-tests.js";

const formatError = (error: unknown): string => error instanceof Error ? error.message : String(error)

const BLOCKED_ERROR_NAME = "LIFECYCLE_OPERATION_BLOCKED";
const BLOCKED_TIMEOUT_MS = 5_000;
const INFERENCE_DURING_SUSPEND_TIMEOUT_MS = 15_000;
const ENSURE_ACTIVE_MAX_ATTEMPTS = 3;
const ENSURE_ACTIVE_BACKOFF_BASE_MS = 100;

export class LifecycleExecutor extends AbstractModelExecutor<typeof lifecycleTests> {
  pattern = /^lifecycle-/;

  protected handlers = {} as never;

  private registryWarmed = false;

  /** Forces registry client init so suspend/resume operates on real resources. */
  private async warmRegistry(): Promise<void> {
    if (this.registryWarmed) return;
    await modelRegistryList();
    this.registryWarmed = true;
  }

  protected defaultHandler = (async (testId: string, _params: {}, expectation: Expectation): Promise<TestResult> => {
    const start = Date.now();

    try {
      await this.warmRegistry();
      const output = await this.runStrategy(testId);
      const elapsed = Date.now() - start;
      await this.ensureActiveStrict();
      return ValidationHelpers.validate(`${output} (${elapsed}ms)`, expectation);
    } catch (error) {
      const recoveryError = await this.ensureActiveStrict().then(() => null, (e: unknown) => formatError(e));
      const detail = recoveryError ? ` [recovery also failed: ${recoveryError}]` : "";
      return { passed: false, output: `lifecycle [${testId}] failed: ${formatError(error)}${detail}` };
    }
  }) as never;

  private async runStrategy(testId: string): Promise<string> {
    switch (testId) {
      case lifecycleSuspendResumeBasic.testId:
        return await this.runSuspendResume();

      case lifecycleSuspendIdempotent.testId:
        return await this.runIdempotentSuspend();

      case lifecycleResumeIdempotent.testId:
        return await this.runIdempotentResume();

      case lifecycleSuspendResumeInference.testId:
        return await this.runInference();

      case lifecycleRapidToggle.testId:
        return await this.runRapidToggle();

      case lifecycleSuspendDuringInference.testId:
        return await this.runSuspendDuringInference();

      case lifecycleStateTransitions.testId:
        return await this.runStateTransitions();

      case lifecycleBlockedCompletion.testId:
        return await this.runBlockedCompletion();

      case lifecycleBlockedRegistry.testId:
        return await this.runBlockedRegistry();

      default:
        throw new Error(`Unknown lifecycle test: ${testId}`);
    }
  }

  private async assertState(expected: LifecycleState): Promise<void> {
    const actual = await state();
    if (actual !== expected) throw new Error(`Expected state "${expected}", got "${actual}"`);
  }

  /** Races a promise against a timeout; rejects with diagnostics if it hangs. */
  private async withTimeout<T>(opName: string, p: Promise<T>, timeoutMs: number): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`${opName} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  /** Expects `fn` to throw LIFECYCLE_OPERATION_BLOCKED; times out if it hangs. */
  private async expectBlocked(
    opName: string,
    fn: () => Promise<unknown>,
    timeoutMs = BLOCKED_TIMEOUT_MS,
  ): Promise<void> {
    try {
      await this.withTimeout(opName, fn(), timeoutMs);
      throw new Error(`${opName} should have thrown ${BLOCKED_ERROR_NAME} while suspended`);
    } catch (error) {
      if ((error as { name?: string }).name === BLOCKED_ERROR_NAME) return;
      throw error;
    }
  }

  /** Retries resume() with backoff until state is "active"; throws after max attempts. */
  private async ensureActiveStrict(maxAttempts = ENSURE_ACTIVE_MAX_ATTEMPTS): Promise<void> {
    let lastError: unknown;
    let lastState: LifecycleState | undefined;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        await resume();
        lastState = await state();
        if (lastState === "active") return;
      } catch (error) {
        lastError = error;
      }
      if (i < maxAttempts - 1) await new Promise(r => setTimeout(r, ENSURE_ACTIVE_BACKOFF_BASE_MS * (i + 1)));
    }
    const reason = lastError
      ? formatError(lastError)
      : `last observed state: "${lastState}"`;
    throw new Error(`Failed to restore runtime to "active" after ${maxAttempts} attempts: ${reason}`);
  }

  private async runSuspendResume(): Promise<string> {
    await suspend();
    await this.assertState("suspended");

    await resume();
    await this.assertState("active");

    const models = await modelRegistryList();
    return `suspend/resume round-trip OK, state transitions verified, registry accessible (${models.length} models)`;
  }

  private async runIdempotentSuspend(): Promise<string> {
    await suspend();
    await suspend();
    await this.assertState("suspended");
    return "Double suspend() OK, state confirmed suspended";
  }

  private async runIdempotentResume(): Promise<string> {
    await resume();
    await resume();
    await this.assertState("active");
    return "Double resume() while active OK, state confirmed active";
  }

  private async runInference(): Promise<string> {
    const modelId = await this.resources.ensureLoaded("llm");

    const textBefore = await completion({
      modelId,
      history: [{ role: "user", content: "What is 2+2? Answer with only the number." }],
      stream: false,
    }).text;

    if (!textBefore?.trim()) throw new Error("Pre-suspend completion returned empty text");

    await suspend();
    await this.assertState("suspended");
    await resume();

    const textAfter = await completion({
      modelId,
      history: [{ role: "user", content: "What is 3+3? Answer with only the number." }],
      stream: false,
    }).text;

    if (!textAfter?.trim()) throw new Error("Post-resume completion returned empty text");

    return `Inference preserved across suspend/resume, pre and post completions non-empty`;
  }

  private async runSuspendDuringInference(): Promise<string> {
    const modelId = await this.resources.ensureLoaded("llm");

    const completionPromise = completion({
      modelId,
      history: [{ role: "user", content: "Count from 1 to 20, one number per line." }],
      stream: false,
    }).text;

    await suspend();

    const text = await this.withTimeout(
      "completion during suspend",
      completionPromise,
      INFERENCE_DURING_SUSPEND_TIMEOUT_MS,
    );

    await resume();
    await this.assertState("active");

    if (!text?.trim()) throw new Error("In-flight completion returned empty text");

    return `Suspend during inference OK, in-flight completion resolved with ${text.trim().length} chars`;
  }

  private async runRapidToggle(): Promise<string> {
    const results = await Promise.allSettled([suspend(), resume()]);
    const failures = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => formatError(r.reason));

    if (failures.length > 0) throw new Error(failures.join("; "));

    // Unconditional resume() guarantees "active" because the lifecycle coordinator processes calls serially.
    await resume();
    await this.assertState("active");
    return `Rapid suspend+resume resolved OK, state confirmed active`;
  }

  private async runStateTransitions(): Promise<string> {
    await this.ensureActiveStrict();
    await this.assertState("active");

    await suspend();
    await this.assertState("suspended");

    await resume();
    await this.assertState("active");

    return `State transitions verified: active -> suspended -> active`;
  }

  private async runBlockedCompletion(): Promise<string> {
    const modelId = await this.resources.ensureLoaded("llm");

    await suspend();

    await this.expectBlocked(
      "completion()",
      () => completion({ modelId, history: [{ role: "user", content: "Test" }], stream: false }).text,
    );

    await resume();
    await this.assertState("active");

    const text = await completion({
      modelId,
      history: [{ role: "user", content: "What is 2+2? Answer with only the number." }],
      stream: false,
    }).text;

    if (!text?.trim()) throw new Error("Post-resume completion returned empty text");

    return `Blocked completion verified: ${BLOCKED_ERROR_NAME} while suspended, non-empty result after resume`;
  }

  private async runBlockedRegistry(): Promise<string> {
    await suspend();

    await this.expectBlocked("modelRegistryList()", () => modelRegistryList());

    await resume();
    await this.assertState("active");

    const models = await modelRegistryList();

    return `Blocked registry verified: ${BLOCKED_ERROR_NAME} while suspended, ${models.length} models after resume`;
  }
}
