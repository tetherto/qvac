import {
  downloadAsset,
  loadModel,
  unloadModel,
  suspend,
  resume,
  WHISPER_TINY,
} from "@qvac/sdk";
import { BaseExecutor, type TestResult } from "@tetherto/qvac-test-suite/mobile";
import {
  downloadResilienceRegistrySuspend,
  downloadResilienceHttpNetdrop,
  downloadResilienceHttpSuspend,
  downloadResilienceHttpSharded,
} from "../../download-resilience-tests.js";

const resilienceTests = [
  downloadResilienceRegistrySuspend,
  downloadResilienceHttpNetdrop,
  downloadResilienceHttpSuspend,
  downloadResilienceHttpSharded,
] as const;

// Must match flaky-lan-server.mjs (QVAC_FLAKY_PORT default).
const FLAKY_PORT = 8099;

const HTTP_RESUME_TIMEOUT_MS = 30_000;
const REGISTRY_RESUME_TIMEOUT_MS = 120_000;
// Stay backgrounded well past the mobile resilience config's 8s
// registryStreamTimeoutMs so the suspended P2P stream definitely times out and
// forces a retry → reconnect (the fix path), not just a natural resume.
const REGISTRY_SUSPEND_MS = 20_000;
const SUSPEND_BACKGROUND_MS = 750;
// Fast check for whether flaky-lan-server is actually reachable. It is on a
// same-LAN local run; it is not on CI Device Farm (the device can't reach the
// runner, and CI never starts it), so the HTTP cases skip there instead of
// burning the full HTTP_RESUME_TIMEOUT_MS.
const FLAKY_PROBE_TIMEOUT_MS = 3_000;

let nonceCounter = 0;
function uniquePath(route: "netdrop" | "suspend"): string {
  // A unique path per run forces a cold download: the SDK cache key is derived
  // from the URL, and the flaky server ignores the nonce.
  nonceCounter += 1;
  return `/${route}/model-${Date.now()}-${nonceCounter}.bin`;
}

function withTimeout<T>(label: string, p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not complete within ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Mobile counterpart of the desktop DownloadResilienceExecutor. The desktop one
 * hosts a node:http server in-process; RN has no node:http, so the HTTP cases
 * download from flaky-lan-server.mjs running on the desktop over the LAN. The
 * registry case needs no server.
 */
export class MobileDownloadResilienceExecutor extends BaseExecutor<typeof resilienceTests> {
  pattern = /^download-resilience-/;

  // Host of the desktop running flaky-lan-server.mjs. It is the same machine as
  // the MQTT broker, so consumer.ts passes through the broker host baked into
  // consumer-config.ts at build time. Undefined on builds without that config.
  constructor(private readonly flakyHost?: string) {
    super();
  }

  private flakyReachable?: boolean;

  /**
   * Returns the flaky-lan-server base URL only if it actually answers, else null.
   * Probed once (the server's presence doesn't change mid-run). The HTTP cases
   * run when it's up (local same-LAN run) and skip when it isn't (CI Device Farm,
   * or the server simply wasn't started).
   */
  private async flakyBaseIfReachable(): Promise<string | null> {
    if (!this.flakyHost) return null;
    const base = `http://${this.flakyHost}:${FLAKY_PORT}`;
    if (this.flakyReachable === undefined) {
      try {
        const res = await withTimeout(
          "flaky-server probe",
          fetch(`${base}/__control/reset`),
          FLAKY_PROBE_TIMEOUT_MS,
        );
        const body = await res.text();
        this.flakyReachable = res.ok && body.trim() === "reset";
      } catch {
        this.flakyReachable = false;
      }
    }
    return this.flakyReachable ? base : null;
  }

  protected handlers = {
    [downloadResilienceRegistrySuspend.testId]: this.registrySuspend.bind(this),
    [downloadResilienceHttpNetdrop.testId]: this.httpNetdrop.bind(this),
    [downloadResilienceHttpSuspend.testId]: this.httpSuspend.bind(this),
    [downloadResilienceHttpSharded.testId]: this.httpSharded.bind(this),
  };

  /** registry:// download must survive suspend/resume and finish from the partial. */
  async registrySuspend(): Promise<TestResult> {
    // A known standalone (non-sharded) registry model — small enough to stay
    // fast, large enough to produce in-flight progress. A sharded model would
    // break the clearStorage eviction below.
    const assetSrc = WHISPER_TINY.src;

    // Force a cold cache so the transfer is genuinely in-flight at suspend():
    // load it (downloads if needed) then unload with clearStorage to delete the
    // file. There's no asset-level cache-evict API and no fs access on-device.
    try {
      const seedId = await loadModel({ modelSrc: WHISPER_TINY });
      await unloadModel({ modelId: seedId, clearStorage: true });
    } catch {
      /* best effort — proceed; the no-progress check below catches a warm cache */
    }

    let firstMidProgress = false;
    let maxPct = 0;
    let lifecycleDone: Promise<void> | null = null;

    const op = downloadAsset({
      assetSrc,
      onProgress: (p: { percentage: number }) => {
        maxPct = Math.max(maxPct, p.percentage);
        if (!firstMidProgress && p.percentage > 0 && p.percentage < 100) {
          firstMidProgress = true;
          lifecycleDone = (async () => {
            try {
              await suspend();
              await delay(REGISTRY_SUSPEND_MS);
            } finally {
              await resume();
            }
          })();
        }
      },
    });

    try {
      const assetId = await withTimeout(
        "registry download (WHISPER_TINY)",
        op,
        REGISTRY_RESUME_TIMEOUT_MS,
      );
      if (!firstMidProgress) {
        return {
          passed: false,
          output: "could not exercise mid-download — WHISPER_TINY produced no in-flight progress after a forced cold cache",
        };
      }
      return {
        passed: true,
        output: `registry download WHISPER_TINY survived suspend/resume: ${assetId} (maxPct=${maxPct.toFixed(1)})`,
      };
    } catch (err) {
      return {
        passed: false,
        output: `registry download did not survive suspend/resume (maxPct=${maxPct.toFixed(1)}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    } finally {
      if (lifecycleDone) {
        try {
          await lifecycleDone;
        } catch {
          /* resume failure surfaces via the lifecycle executor's recovery */
        }
      }
    }
  }

  /** https:// download must recover from a mid-stream socket drop via range resume. */
  async httpNetdrop(): Promise<TestResult> {
    const base = await this.flakyBaseIfReachable();
    if (!base) {
      return {
        passed: true,
        skipped: true,
        output: "skipped: flaky-lan-server not reachable (start it locally with `node tests/shared/flaky-lan-server.mjs`; unreachable on CI Device Farm)",
      };
    }
    const assetSrc = `${base}${uniquePath("netdrop")}`;
    let maxPct = 0;
    try {
      const op = downloadAsset({
        assetSrc,
        onProgress: (p: { percentage: number }) => {
          maxPct = Math.max(maxPct, p.percentage);
        },
      });
      const assetId = await withTimeout("http netdrop download", op, HTTP_RESUME_TIMEOUT_MS);
      return {
        passed: true,
        output: `http download recovered from mid-stream drop: ${assetId} (maxPct=${maxPct.toFixed(1)})`,
      };
    } catch (err) {
      return {
        passed: false,
        output: `http download did not recover from mid-stream drop (maxPct=${maxPct.toFixed(1)}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  /** https:// download must survive suspend/resume even when the socket dies on background. */
  async httpSuspend(): Promise<TestResult> {
    const base = await this.flakyBaseIfReachable();
    if (!base) {
      return {
        passed: true,
        skipped: true,
        output: "skipped: flaky-lan-server not reachable (start it locally with `node tests/shared/flaky-lan-server.mjs`; unreachable on CI Device Farm)",
      };
    }
    const path = uniquePath("suspend");
    const assetSrc = `${base}${path}`;
    let firstProgress = false;
    let maxPct = 0;
    let lifecycleDone: Promise<void> | null = null;
    try {
      const op = downloadAsset({
        assetSrc,
        onProgress: (p: { percentage: number }) => {
          maxPct = Math.max(maxPct, p.percentage);
          if (!firstProgress && p.percentage > 0 && p.percentage < 100) {
            firstProgress = true;
            lifecycleDone = (async () => {
              await suspend();
              // Model the OS killing the in-flight socket while backgrounded.
              // The control fetch is cleartext to the LAN, which works here (the
              // device reaches the broker over cleartext ws:// the same way).
              try {
                await fetch(`${base}/__control/sever?key=${encodeURIComponent(path)}`);
              } catch {
                /* sever best-effort; the stall watchdog still recovers */
              }
              await delay(SUSPEND_BACKGROUND_MS);
              await resume();
            })();
          }
        },
      });
      const assetId = await withTimeout("http suspend download", op, HTTP_RESUME_TIMEOUT_MS);
      if (lifecycleDone) await lifecycleDone;
      if (!firstProgress) {
        return { passed: false, output: "could not exercise mid-download — no in-flight progress" };
      }
      return {
        passed: true,
        output: `http download survived suspend with dropped socket: ${assetId} (maxPct=${maxPct.toFixed(1)})`,
      };
    } catch (err) {
      return {
        passed: false,
        output: `http download did not survive suspend with dropped socket (maxPct=${maxPct.toFixed(1)}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    } finally {
      if (lifecycleDone) {
        try {
          await lifecycleDone;
        } catch {
          /* resume failure surfaces via the lifecycle executor's recovery */
        }
      }
    }
  }

  /** Sharded https:// download — not implemented for the mobile harness. */
  async httpSharded(): Promise<TestResult> {
    // The desktop version fronts the real HF sharded model with a node:http
    // severing proxy. Porting that to the LAN-server harness (serve/sever real
    // multi-hundred-MB shards) is a separate task; not attempted here.
    return {
      passed: true,
      skipped: true,
      output: "skipped: sharded http resilience not implemented for the mobile LAN-server harness",
    };
  }
}
