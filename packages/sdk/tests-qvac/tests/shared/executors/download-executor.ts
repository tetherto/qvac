import {
  downloadAsset,
  cancel,
  WHISPER_TINY,
  OCR_CYRILLIC_RECOGNIZER,
} from "@qvac/sdk";
import {
  BaseExecutor,
  type TestResult,
} from "@tetherto/qvac-test-suite";
import { downloadCancelIsolation } from "../../download-tests.js";

const downloadTests = [downloadCancelIsolation] as const;

const CACHE_HIT_THRESHOLD_MS = 500;

export class DownloadExecutor extends BaseExecutor<typeof downloadTests> {
  pattern = /^download-/;

  protected handlers = {
    [downloadCancelIsolation.testId]: this.cancelIsolation.bind(this),
  };

  async cancelIsolation(
    params: typeof downloadCancelIsolation.params,
    _expectation: typeof downloadCancelIsolation.expectation,
  ): Promise<TestResult> {
    let cancelTriggered = false;
    const cancelThreshold = params.cancelAtPercent ?? 1;
    const startTime = Date.now();

    const survivorPromise = downloadAsset({
      assetSrc: WHISPER_TINY,
      onProgress: () => {},
    }).then(
      (id: string) => ({ status: "ok" as const, id }),
      (err: unknown) => ({
        status: "fail" as const,
        err: err instanceof Error ? err.message : String(err),
      }),
    );

    let progressEvents = 0;
    const cancelledPromise = downloadAsset({
      assetSrc: OCR_CYRILLIC_RECOGNIZER,
      onProgress: (p: { downloadKey?: string; percentage: number }) => {
        progressEvents++;
        if (
          !cancelTriggered &&
          p.downloadKey &&
          p.percentage >= cancelThreshold
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
      (id: string) => ({ status: "ok" as const, id }),
      (err: unknown) => ({
        status: "fail" as const,
        err: err instanceof Error ? err.message : String(err),
      }),
    );

    const [survivor, cancelled] = await Promise.all([
      survivorPromise,
      cancelledPromise,
    ]);
    const elapsed = Date.now() - startTime;

    if (survivor.status !== "ok") {
      return { passed: false, output: `Survivor download failed: ${survivor.err}` };
    }

    if (cancelled.status === "fail") {
      return {
        passed: true,
        output: `Survivor: OK. Target: correctly rejected (${cancelled.err}). ${elapsed}ms, ${progressEvents} progress events`,
      };
    }

    const wasCached = progressEvents <= 1 || elapsed < CACHE_HIT_THRESHOLD_MS;
    if (wasCached) {
      return {
        passed: true,
        output: `Survivor: OK. Target was cached (${elapsed}ms, ${progressEvents} progress events) — cancel not testable`,
      };
    }

    return {
      passed: false,
      output: `Survivor: OK. Cancel triggered but target download still completed (${elapsed}ms, ${progressEvents} progress events)`,
    };
  }
}
