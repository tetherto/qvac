import * as path from "node:path";
import {
  type Expectation,
  type TestResult,
} from "@tetherto/qvac-test-suite";
import {
  CancellationExecutor,
  type TranscribeCancelParams,
} from "../../shared/executors/cancellation-executor.js";
import {
  cancelBroadTranscribe,
  cancelByRequestIdTranscribe,
} from "../../cancellation-tests.js";

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
    return this.transcribeWithCancel(this.resolveAudio(params.audioFileName), "broad", params.cancelAfterMs);
  }

  async transcribeTargeted(
    params: TranscribeCancelParams,
    _expectation: Expectation,
  ): Promise<TestResult> {
    return this.transcribeWithCancel(this.resolveAudio(params.audioFileName), "requestId", params.cancelAfterMs);
  }

  private resolveAudio(audioFileName: string): string {
    return path.resolve(process.cwd(), "assets/audio", audioFileName);
  }
}
