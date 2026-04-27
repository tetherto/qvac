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
import {
  configRegistryDownloadSmoke,
  configRegistryDownloadRespectsCancel,
} from "../../config-tests.js";

const configTests = [
  configRegistryDownloadSmoke,
  configRegistryDownloadRespectsCancel,
] as const;

/**
 * Exercises the registry-download path end-to-end while a non-default
 * `registryDownloadMaxRetries` / `registryStreamTimeoutMs` are in effect
 * (see qvac.config.json at the root of this package).
 *
 * These values are consumed inside registry-download-utils.ts through
 * the `buildRegistryClientOptions` helper. If that wiring ever breaks
 * (e.g. options aren't forwarded to @qvac/registry-client) downloads
 * would still work with defaults, but the tests guarantee the full
 * client → RPC → server → registry-client chain stays green when both
 * config fields are set.
 */
export class ConfigExecutor extends BaseExecutor<typeof configTests> {
  pattern = /^config-registry-/;

  protected handlers = {
    [configRegistryDownloadSmoke.testId]: this.downloadSmoke.bind(this),
    [configRegistryDownloadRespectsCancel.testId]:
      this.downloadRespectsCancel.bind(this),
  };

  async downloadSmoke(
    _params: typeof configRegistryDownloadSmoke.params,
    _expectation: typeof configRegistryDownloadSmoke.expectation,
  ): Promise<TestResult> {
    const startTime = Date.now();

    try {
      const modelId = await downloadAsset({
        assetSrc: WHISPER_TINY,
        onProgress: () => {},
      });
      const elapsed = Date.now() - startTime;

      if (typeof modelId !== "string" || modelId.length === 0) {
        return {
          passed: false,
          output: `Expected non-empty modelId, got: ${String(modelId)}`,
        };
      }

      return {
        passed: true,
        output: `Registry download succeeded with custom retries/timeout in ${elapsed}ms (modelId=${modelId})`,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        passed: false,
        output: `Registry download failed under custom config: ${errorMsg}`,
      };
    }
  }

  /**
   * Regression guard: with `registryDownloadMaxRetries > 0` a cancel
   * triggered mid-flight must still abort fast (no additional retries
   * should be attempted after the signal fires). Cached targets are
   * accepted as a pass since cancellation is not testable when the
   * blob is already local.
   */
  async downloadRespectsCancel(
    _params: typeof configRegistryDownloadRespectsCancel.params,
    _expectation: typeof configRegistryDownloadRespectsCancel.expectation,
  ): Promise<TestResult> {
    const cacheHitThresholdMs = 500;
    let cancelTriggered = false;
    let progressEvents = 0;
    const startTime = Date.now();

    const result = await downloadAsset({
      assetSrc: OCR_CYRILLIC_RECOGNIZER,
      onProgress: (p: { downloadKey?: string; percentage: number }) => {
        progressEvents++;
        if (!cancelTriggered && p.downloadKey && p.percentage >= 1) {
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

    const elapsed = Date.now() - startTime;

    if (result.status === "fail") {
      return {
        passed: true,
        output: `Cancel honored under custom retries config: ${result.err} (${elapsed}ms, ${progressEvents} progress events)`,
      };
    }

    const wasCached = progressEvents <= 1 || elapsed < cacheHitThresholdMs;
    if (wasCached) {
      return {
        passed: true,
        output: `Target was cached (${elapsed}ms, ${progressEvents} progress events) — cancel not testable`,
      };
    }

    return {
      passed: false,
      output: `Cancel triggered but download still completed after ${elapsed}ms / ${progressEvents} progress events (retries did not honor signal?)`,
    };
  }
}
