import { suspend, resume, completion, modelRegistryList } from "@qvac/sdk";
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
} from "../../lifecycle-tests.js";

const formatError = (error: unknown): string => error instanceof Error ? error.message : String(error)

export class LifecycleExecutor extends AbstractModelExecutor<typeof lifecycleTests> {
  pattern = /^lifecycle-/;

  protected handlers = {} as never;

  private registryWarmed = false;

  /**
   * Ensures the registry client is initialized so that its swarm and corestore
   * are registered with the lifecycle coordinator. Without this, suspend/resume
   * would operate on zero resources -- a no-op state flip.
   */
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
      await this.ensureActive();
      return ValidationHelpers.validate(`${output} (${elapsed}ms)`, expectation);
    } catch (error) {
      await this.ensureActive();
      return { passed: false, output: `lifecycle [${testId}] failed: ${formatError(error)}` };
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

      default:
        throw new Error(`Unknown lifecycle test: ${testId}`);
    }
  }

  private async runSuspendResume(): Promise<string> {
    await suspend();
    await resume();

    const models = await modelRegistryList();
    return `suspend/resume round-trip OK, registry accessible after resume (${models.length} models)`;
  }

  private async runIdempotentSuspend(): Promise<string> {
    await suspend();
    await suspend();
    return "Double suspend() OK";
  }

  private async runIdempotentResume(): Promise<string> {
    await resume();
    await resume();
    return "Double resume() while active OK";
  }

  private async runInference(): Promise<string> {
    const modelId = await this.resources.ensureLoaded("llm");

    const textBefore = await completion({
      modelId,
      history: [{ role: "user", content: "What is 2+2? Answer with only the number." }],
      stream: false,
    }).text;

    if (!textBefore?.trim()) {
      throw new Error("Pre-suspend completion returned empty text");
    }

    await suspend();
    await resume();

    const textAfter = await completion({
      modelId,
      history: [{ role: "user", content: "What is 3+3? Answer with only the number." }],
      stream: false,
    }).text;

    if (!textAfter?.trim()) {
      throw new Error("Post-resume completion returned empty text");
    }

    const models = await modelRegistryList();
    return `Inference preserved, registry OK (${models.length} models). Before: "${textBefore.trim()}", After: "${textAfter.trim()}"`;
  }

  private async runSuspendDuringInference(): Promise<string> {
    const modelId = await this.resources.ensureLoaded("llm");

    const completionPromise = completion({
      modelId,
      history: [{ role: "user", content: "Count from 1 to 20, one number per line." }],
      stream: false,
    }).text;

    await suspend();

    const text = await completionPromise;

    await resume();

    if (!text?.trim()) {
      throw new Error("Completion during suspend returned empty text");
    }

    const models = await modelRegistryList();
    return `Suspend during inference OK, got ${text.trim().length} chars, registry accessible (${models.length} models)`;
  }

  private async runRapidToggle(): Promise<string> {
    const results = await Promise.allSettled([suspend(), resume()]);
    const failures = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => formatError(r.reason));

    if (failures.length > 0) throw new Error(failures.join("; "));

    await resume();
    const models = await modelRegistryList();
    return `Rapid suspend+resume resolved OK, registry accessible (${models.length} models)`;
  }

  private async ensureActive(): Promise<void> {
    try { await resume(); } catch { /* best-effort restore for subsequent tests */ }
  }
}
