import { cancel, transcribe } from "@qvac/sdk";
import * as path from "node:path";
import {
  type Expectation,
  type TestResult,
} from "@tetherto/qvac-test-suite";
import {
  CancellationExecutor,
  describeError,
  isCancellationError,
  markHandled,
  sleep,
} from "../../shared/executors/cancellation-executor.js";
import {
  cancelBroadTranscribe,
  cancelByRequestIdTranscribe,
} from "../../cancellation-tests.js";

type CancelForm = "broad" | "requestId";

interface TranscribeCancelParams {
  audioFileName: string;
  cancelAfterMs: number;
}

export class DesktopCancellationExecutor extends CancellationExecutor {
  protected override handlers = {
    ...this.buildSharedHandlers(),
    [cancelBroadTranscribe.testId]: this.transcribeBroad.bind(this),
    [cancelByRequestIdTranscribe.testId]: this.transcribeTargeted.bind(this),
  } as never;

  async transcribeBroad(
    params: TranscribeCancelParams,
    _expectation: Expectation,
  ): Promise<TestResult> {
    return this.transcribeRun(params, "broad");
  }

  async transcribeTargeted(
    params: TranscribeCancelParams,
    _expectation: Expectation,
  ): Promise<TestResult> {
    return this.transcribeRun(params, "requestId");
  }

  private async transcribeRun(
    params: TranscribeCancelParams,
    cancelForm: CancelForm,
  ): Promise<TestResult> {
    const modelId = await this.resources.ensureLoaded("whisper");
    const audioPath = path.resolve(
      process.cwd(),
      "assets/audio",
      params.audioFileName,
    );

    const op = markHandled(transcribe({ modelId, audioChunk: audioPath }));
    const startMs = Date.now();
    await sleep(params.cancelAfterMs);

    try {
      if (cancelForm === "broad") {
        await cancel({ modelId, kind: "transcribe" });
      } else {
        await cancel({ requestId: op.requestId });
      }
    } catch (err) {
      return {
        passed: false,
        output: `cancel(${cancelForm}) for transcribe rejected: ${describeError(err)}`,
      };
    }

    try {
      const text = await op;
      const elapsedMs = Date.now() - startMs;
      return {
        passed: false,
        output:
          `transcribe resolved with ${text.length} chars after cancel(${cancelForm}) ` +
          `(elapsed=${elapsedMs}ms). Pick a longer audio source for reliable coverage.`,
      };
    } catch (err) {
      const elapsedMs = Date.now() - startMs;
      if (err instanceof Error && isCancellationError(err)) {
        return {
          passed: true,
          output: `transcribe cancel(${cancelForm}) OK: ${describeError(err)} (elapsed=${elapsedMs}ms)`,
        };
      }
      return {
        passed: false,
        output: `transcribe rejected with non-cancellation error on cancel(${cancelForm}): ${describeError(err)}`,
      };
    }
  }
}
