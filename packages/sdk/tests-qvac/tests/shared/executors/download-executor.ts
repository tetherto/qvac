import {
  downloadAsset,
  cancel,
  WHISPER_TINY,
  VAD_SILERO_5_1_2,
} from "@qvac/sdk";
import {
  BaseExecutor,
  type TestResult,
} from "@tetherto/qvac-test-suite";
import { downloadCancelIsolation } from "../../download-tests.js";

const downloadTests = [downloadCancelIsolation] as const;

export class DownloadExecutor extends BaseExecutor<typeof downloadTests> {
  pattern = /^download-/;

  protected handlers = {
    [downloadCancelIsolation.testId]: this.cancelIsolation.bind(this),
  };

  async cancelIsolation(
    params: typeof downloadCancelIsolation.params,
    expectation: typeof downloadCancelIsolation.expectation,
  ): Promise<TestResult> {
    let cancelTriggered = false;

    const survivorPromise = downloadAsset({
      assetSrc: WHISPER_TINY,
      onProgress: () => {},
    }).then(
      (id) => ({ status: "ok" as const, id }),
      (err: unknown) => ({
        status: "fail" as const,
        err: err instanceof Error ? err.message : String(err),
      }),
    );

    const cancelledPromise = downloadAsset({
      assetSrc: VAD_SILERO_5_1_2,
      onProgress: (p: { downloadKey?: string; percentage: number }) => {
        if (
          !cancelTriggered &&
          p.downloadKey &&
          p.percentage >= (params.cancelAtPercent ?? 1)
        ) {
          cancelTriggered = true;
          void cancel({
            operation: "downloadAsset",
            downloadKey: p.downloadKey,
            clearCache: true,
          });
        }
      },
    }).then(
      (id) => ({ status: "ok" as const, id }),
      (err: unknown) => ({
        status: "fail" as const,
        err: err instanceof Error ? err.message : String(err),
      }),
    );

    const [survivor, cancelled] = await Promise.all([
      survivorPromise,
      cancelledPromise,
    ]);

    const survivorOk = survivor.status === "ok";
    const cancelledFailed = cancelled.status === "fail";

    const survivorDetail =
      survivor.status === "ok"
        ? `OK (${survivor.id})`
        : `FAILED (${survivor.err})`;
    const cancelledDetail =
      cancelled.status === "fail"
        ? `correctly rejected (${cancelled.err})`
        : `should have been cancelled but succeeded (${cancelled.id})`;

    return {
      passed: survivorOk && cancelledFailed,
      output: `Survivor (Whisper): ${survivorDetail}. Cancelled (VAD): ${cancelledDetail}`,
    };
  }
}
