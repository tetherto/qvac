import * as path from "node:path";
import {
  type Expectation,
  type TestResult,
} from "@tetherto/qvac-test-suite";
import {
  CancellationExecutor,
  type TranscribeCancelParams,
} from "../cancellation-executor.js";
import { cancelByRequestIdTranscribe } from "../../../cancellation-tests.js";

export class NodeCancellationExecutor extends CancellationExecutor {
  protected override handlers = {
    ...this.buildSharedHandlers(),
    [cancelByRequestIdTranscribe.testId]: this.transcribeTargeted.bind(this),
  } as never;

  async transcribeTargeted(
    params: TranscribeCancelParams,
    _expectation: Expectation,
  ): Promise<TestResult> {
    return this.transcribeWithCancel(this.resolveAudio(params.audioFileName));
  }

  private resolveAudio(audioFileName: string): string {
    return path.resolve(process.cwd(), "assets/audio", audioFileName);
  }
}
