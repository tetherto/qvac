import { finetune } from "@qvac/sdk";
import type { FinetuneProgress, FinetuneResult } from "@qvac/sdk";
import {
  ValidationHelpers,
  type TestResult,
  type Expectation,
} from "@tetherto/qvac-test-suite";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
} from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { AbstractModelExecutor } from "../../shared/executors/abstract-model-executor.js";
import { finetuneTests } from "../../finetune-tests.js";

const FINETUNE_DEPENDENCY = "finetune-llm";

interface DatasetPaths {
  tempRoot: string;
  trainPath: string;
  evalPath: string;
  outputDir: string;
  checkpointDir: string;
}

interface BaseParams {
  numberOfEpochs?: number;
}

interface PauseResumeParams extends BaseParams {
  pauseAfterGlobalSteps?: number;
}

interface ProgressParams extends BaseParams {
  minimumProgressEvents?: number;
}

export class FinetuneExecutor extends AbstractModelExecutor<typeof finetuneTests> {
  pattern = /^finetune-/;
  private tempRoots = new Set<string>();

  async setup(testId: string, context: unknown) {
    await super.setup(testId, context);
    await this.cancelActiveFinetune();
  }

  protected handlers = {
    "finetune-start-complete": this.startComplete.bind(this),
    "finetune-pause-resume": this.pauseResume.bind(this),
    "finetune-progress-streaming": this.progressStreaming.bind(this),
    "finetune-error-cases": this.errorCases.bind(this),
  } as never;

  async teardown(testId: string, context: unknown) {
    try {
      await this.cancelActiveFinetune();

      for (const tempRoot of this.tempRoots) {
        await rm(tempRoot, { recursive: true, force: true });
      }
      this.tempRoots.clear();
    } finally {
      await super.teardown(testId, context);
    }
  }

  async startComplete(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as BaseParams;
    const modelId = await this.resources.ensureLoaded(FINETUNE_DEPENDENCY);
    const paths = await this.createDatasets();

    try {
      const handle = finetune({
        modelId,
        options: this.buildOptions(paths, p.numberOfEpochs ?? 1),
      });
      const progress = await this.collectProgress(handle.progressStream);
      const result = await handle.result;

      if (result.status !== "COMPLETED") {
        return {
          passed: false,
          output: `Expected COMPLETED status, got ${result.status}`,
        };
      }

      if (progress.length === 0) {
        return { passed: false, output: "Expected at least one finetune progress update" };
      }

      if (typeof result.stats?.global_steps !== "number") {
        return { passed: false, output: "Expected terminal finetune stats.global_steps" };
      }

      return ValidationHelpers.validate(
        `Completed finetune with ${progress.length} progress updates and ${result.stats.global_steps} steps`,
        expectation as Expectation,
      );
    } catch (error) {
      return this.failWithError("finetune start/complete", error);
    }
  }

  async pauseResume(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as PauseResumeParams;
    const modelId = await this.resources.ensureLoaded(FINETUNE_DEPENDENCY);
    const paths = await this.createDatasets();
    const pauseAfterGlobalSteps = p.pauseAfterGlobalSteps ?? 2;
    const pauseOperation = finetune as (params: {
      modelId: string;
      operation: "pause";
    }) => Promise<FinetuneResult>;

    try {
      const initialHandle = finetune({
        modelId,
        options: this.buildOptions(paths, p.numberOfEpochs ?? 2),
      });

      let pauseRequested = false;
      let pausePromise: Promise<FinetuneResult> | null = null;
      const initialProgressPromise = this.collectProgress(
        initialHandle.progressStream,
        async (update) => {
          if (!pauseRequested && update.global_steps >= pauseAfterGlobalSteps) {
            pauseRequested = true;
            pausePromise = pauseOperation({
              modelId,
              operation: "pause",
            });
          }
        },
      );
      const initialResult = await initialHandle.result;
      const initialProgress = await initialProgressPromise;
      let pauseResult: FinetuneResult | null = null;
      if (pausePromise !== null) {
        pauseResult = await pausePromise;
      }

      if (!pauseRequested) {
        return { passed: false, output: "Pause was never requested from finetune progress" };
      }

      const resolvedPauseResult = pauseResult as FinetuneResult | null;

      if (initialResult.status !== "PAUSED") {
        return {
          passed: false,
          output: `Expected initial finetune to pause, got ${initialResult.status}`,
        };
      }

      if (!resolvedPauseResult || resolvedPauseResult.status !== "PAUSED") {
        return {
          passed: false,
          output:
            `Expected pause operation to return PAUSED, got ${resolvedPauseResult?.status ?? "none"}`,
        };
      }

      const resumeHandle = finetune({
        modelId,
        operation: "resume",
        options: this.buildOptions(paths, p.numberOfEpochs ?? 2),
      });
      const resumedProgress = await this.collectProgress(resumeHandle.progressStream);
      const resumedResult = await resumeHandle.result;

      if (resumedResult.status !== "COMPLETED") {
        return {
          passed: false,
          output: `Expected resumed finetune to complete, got ${resumedResult.status}`,
        };
      }

      if (
        typeof initialResult.stats?.global_steps === "number" &&
        typeof resumedResult.stats?.global_steps === "number" &&
        resumedResult.stats.global_steps <= initialResult.stats.global_steps
      ) {
        return {
          passed: false,
          output:
            `Expected resumed finetune steps to advance beyond ${initialResult.stats.global_steps}, ` +
            `got ${resumedResult.stats.global_steps}`,
        };
      }

      return ValidationHelpers.validate(
        `Paused after ${initialProgress.length} updates and resumed with ${resumedProgress.length} more updates`,
        expectation as Expectation,
      );
    } catch (error) {
      return this.failWithError("finetune pause/resume", error);
    }
  }

  async progressStreaming(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as ProgressParams;
    const modelId = await this.resources.ensureLoaded(FINETUNE_DEPENDENCY);
    const paths = await this.createDatasets();

    try {
      const handle = finetune({
        modelId,
        options: this.buildOptions(paths, p.numberOfEpochs ?? 1),
      });
      const progress = await this.collectProgress(handle.progressStream);
      const result = await handle.result;

      if (result.status !== "COMPLETED") {
        return {
          passed: false,
          output: `Expected COMPLETED status, got ${result.status}`,
        };
      }

      if (progress.length < (p.minimumProgressEvents ?? 1)) {
        return {
          passed: false,
          output:
            `Expected at least ${p.minimumProgressEvents ?? 1} progress events, got ${progress.length}`,
        };
      }

      for (let i = 1; i < progress.length; i++) {
        if (progress[i]!.global_steps < progress[i - 1]!.global_steps) {
          return {
            passed: false,
            output: "Finetune progress global_steps must be monotonic",
          };
        }
      }

      const lastProgress = progress[progress.length - 1]!;
      if (typeof lastProgress.elapsed_ms !== "number" || lastProgress.elapsed_ms < 0) {
        return { passed: false, output: "Expected non-negative elapsed_ms in finetune progress" };
      }

      return ValidationHelpers.validate(
        `Observed ${progress.length} monotonic finetune progress updates`,
        expectation as Expectation,
      );
    } catch (error) {
      return this.failWithError("finetune progress streaming", error);
    }
  }

  async errorCases(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as { invalidModelId: string };
    const modelId = await this.resources.ensureLoaded(FINETUNE_DEPENDENCY);
    const paths = await this.createDatasets();
    const invalidTrainPath = path.join(paths.tempRoot, "missing-train.jsonl");

    try {
      let invalidModelRejected = false;
      try {
        await finetune({ modelId: p.invalidModelId, operation: "pause" });
      } catch {
        invalidModelRejected = true;
      }

      if (!invalidModelRejected) {
        return { passed: false, output: "Expected invalid finetune modelId to be rejected" };
      }

      const handle = finetune({
        modelId,
        options: {
          ...this.buildOptions(paths, 1),
          trainDatasetDir: invalidTrainPath,
        },
      });

      let invalidDatasetRejected = false;
      try {
        await handle.result;
      } catch {
        invalidDatasetRejected = true;
      }

      if (!invalidDatasetRejected) {
        return { passed: false, output: "Expected invalid finetune dataset path to be rejected" };
      }

      return ValidationHelpers.validate(
        "Rejected invalid model id and invalid finetune dataset path",
        expectation as Expectation,
      );
    } catch (error) {
      return this.failWithError("finetune error cases", error);
    }
  }

  private async collectProgress(
    progressStream: AsyncGenerator<FinetuneProgress>,
    onProgress?: (progress: FinetuneProgress) => Promise<void> | void,
  ) {
    const updates: FinetuneProgress[] = [];

    for await (const update of progressStream) {
      updates.push(update);
      if (onProgress) {
        await onProgress(update);
      }
    }

    return updates;
  }

  private buildOptions(paths: DatasetPaths, numberOfEpochs: number) {
    return {
      trainDatasetDir: paths.trainPath,
      validation: {
        type: "dataset" as const,
        path: paths.evalPath,
      },
      outputParametersDir: paths.outputDir,
      checkpointSaveDir: paths.checkpointDir,
      checkpointSaveSteps: 2,
      numberOfEpochs,
      learningRate: 1e-5,
      lrMin: 1e-8,
      assistantLossOnly: true,
      loraModules: "attn_q,attn_k,attn_v,attn_o,ffn_gate,ffn_up,ffn_down",
    };
  }

  private async createDatasets() {
    const trainPath = await this.resolveAssetPath("finetune_train_tiny_HF.jsonl");
    const evalPath = await this.resolveAssetPath("finetune_eval_tiny_HF.jsonl");
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "qvac-sdk-finetune-"));
    const outputDir = path.join(tempRoot, "output");
    const checkpointDir = path.join(tempRoot, "checkpoints");

    this.tempRoots.add(tempRoot);

    await mkdir(outputDir, { recursive: true });
    await mkdir(checkpointDir, { recursive: true });

    return {
      tempRoot,
      trainPath,
      evalPath,
      outputDir,
      checkpointDir,
    };
  }

  private async resolveAssetPath(fileName: string) {
    const candidates = [
      path.resolve(process.cwd(), "assets/documents", fileName),
      path.resolve(process.cwd(), "tests-qvac/assets/documents", fileName),
      path.resolve(process.cwd(), "../../assets/documents", fileName),
    ];

    for (const candidate of candidates) {
      try {
        await access(candidate);
        return candidate;
      } catch {}
    }

    throw new Error(`Unable to resolve finetune test asset: ${fileName}`);
  }

  private failWithError(prefix: string, error: unknown): TestResult {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      output: `${prefix} failed: ${errorMessage}`,
    };
  }

  private async cancelActiveFinetune() {
    const modelId = this.resources.getModelId(FINETUNE_DEPENDENCY);

    if (!modelId) {
      return;
    }

    try {
      await finetune({ modelId, operation: "cancel" });
    } catch {}
  }
}
