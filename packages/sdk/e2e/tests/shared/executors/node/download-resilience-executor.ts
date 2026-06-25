import { downloadAsset, suspend, resume, modelRegistryList } from "@qvac/sdk";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { BaseExecutor, type TestResult } from "@tetherto/qvac-test-suite";
import {
  downloadResilienceRegistrySuspend,
  downloadResilienceHttpNetdrop,
  downloadResilienceHttpSuspend,
  downloadResilienceHttpSharded,
} from "../../../download-resilience-tests.js";

const resilienceTests = [
  downloadResilienceRegistrySuspend,
  downloadResilienceHttpNetdrop,
  downloadResilienceHttpSuspend,
  downloadResilienceHttpSharded,
] as const;

const PAYLOAD_BYTES = 6 * 1024 * 1024;
const SUSPEND_BACKGROUND_MS = 750;
const REGISTRY_RESUME_TIMEOUT_MS = 60_000;
const HTTP_RESUME_TIMEOUT_MS = 30_000;

// Sharded resilience: front the real sharded model with a proxy that severs one
// shard's transfer once. Downloads a real (~hundreds of MB) model, so it is
// gated behind QVAC_E2E_HTTP_SHARDED_RESILIENCE and excluded from the default suite.
const HF_ORIGIN = "https://huggingface.co";
const SHARDED_MODEL_PATH =
  "/opaninakuffo/gte-large-fp16-sharded/resolve/main/gte-large_fp16-00003-of-00005.gguf";
const SHARD_TO_SEVER = "-00002-of-";
const SHARD_SEVER_AT_BYTES = 16 * 1024 * 1024;
const SHARDED_RESUME_TIMEOUT_MS = 300_000;

// The registry stream must stall past its per-block timeout while suspended so
// that resume() forces a reconnect-then-retry. Run this test with the short
// registryStreamTimeoutMs from fixtures/qvac.config.e2e.resilience.json; the
// suspend window below must exceed it. (Excluded from the default CI suite.)
const REGISTRY_SUSPEND_MS = 4_000;

// Pick a registry model large enough to stay in-flight long enough to suspend
// mid-download, but small enough to keep the test fast. Tiny companion files
// (e.g. a 123-byte `mecabrc`) complete before any intermediate progress fires.
const REGISTRY_MIN_BYTES = 8 * 1024 * 1024;
const REGISTRY_MAX_BYTES = 200 * 1024 * 1024;

// Mirrors server-side getSingleFileCachePath() so the test can force a cold
// download. Kept in the test as cold-start scaffolding, not an assertion.
function singleFileCachePath(registryPath: string): string {
  const filename = registryPath.split("/").pop() || registryPath;
  const hash = crypto
    .createHash("sha256")
    .update(Buffer.from(registryPath, "utf8"))
    .digest("hex")
    .substring(0, 16);
  return path.join(os.homedir(), ".qvac", "models", `${hash}_${filename}`);
}

function buildPayload(size: number): Buffer {
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) buf[i] = i & 0xff;
  return buf;
}

function parseRangeStart(header: string | undefined): number {
  if (!header) return 0;
  const m = /bytes=(\d+)-/.exec(header);
  return m && m[1] ? parseInt(m[1], 10) : 0;
}

/**
 * Local HTTP file server that models a flaky network. It serves a fixed payload
 * with Range support and severs the connection once mid-stream; the next request
 * (a Range resume) is served to completion. In "manual" mode the sever is
 * triggered externally (to coincide with suspend()); in "auto" mode it severs
 * after a byte threshold on the first response.
 */
class FlakyFileServer {
  readonly payload: Buffer;
  private readonly mode: "auto" | "manual";
  private readonly severAtBytes: number;
  private server?: http.Server;
  private port = 0;
  private severedOnce = false;
  private activeResponse: http.ServerResponse | null = null;

  constructor(opts: { mode: "auto" | "manual"; severAtBytes?: number }) {
    this.payload = buildPayload(PAYLOAD_BYTES);
    this.mode = opts.mode;
    this.severAtBytes = opts.severAtBytes ?? Math.floor(PAYLOAD_BYTES / 3);
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => {
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    this.port = (this.server!.address() as AddressInfo).port;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/resilience-model.bin`;
  }

  /** Drops the connection currently being served (manual mode). */
  sever(): void {
    if (this.activeResponse) {
      this.severedOnce = true;
      this.activeResponse.destroy();
      this.activeResponse = null;
    }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const total = this.payload.length;

    if (req.method === "HEAD") {
      res.writeHead(200, {
        "content-length": String(total),
        "accept-ranges": "bytes",
      });
      res.end();
      return;
    }

    const start = parseRangeStart(req.headers["range"] as string | undefined);
    const slice = this.payload.subarray(start);

    if (start > 0) {
      res.writeHead(206, {
        "content-length": String(slice.length),
        "content-range": `bytes ${start}-${total - 1}/${total}`,
        "accept-ranges": "bytes",
      });
    } else {
      res.writeHead(200, {
        "content-length": String(total),
        "accept-ranges": "bytes",
      });
    }

    // A resumed request (Range) or any request after the one sever — serve fully.
    if (start > 0 || this.severedOnce) {
      res.end(slice);
      return;
    }

    // Trickle bytes so the client receives a real partial before the drop.
    // "auto" severs once it has delivered severAtBytes (a mid-stream network
    // drop); "manual" keeps flowing until sever() is called (on suspend).
    this.activeResponse = res;
    let offset = 0;
    const chunk = Math.max(64 * 1024, Math.floor(this.severAtBytes / 8));
    const pump = () => {
      if (res !== this.activeResponse || res.destroyed) return;
      if (this.mode === "auto" && !this.severedOnce && offset >= this.severAtBytes) {
        this.severedOnce = true;
        res.destroy();
        this.activeResponse = null;
        return;
      }
      if (offset >= total) {
        res.end();
        this.activeResponse = null;
        return;
      }
      res.write(this.payload.subarray(offset, offset + chunk));
      offset += chunk;
      setTimeout(pump, 40);
    };
    pump();
  }

  async close(): Promise<void> {
    if (this.activeResponse) {
      this.activeResponse.destroy();
      this.activeResponse = null;
    }
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
  }
}

/**
 * Reverse proxy in front of the real sharded model on HuggingFace. It relays
 * each shard request (forwarding Range), and severs one designated shard's
 * transfer exactly once mid-stream to simulate a network drop. The resumed
 * (Range) request is served to completion, so a working retry/resume recovers.
 */
class ShardSeverProxy {
  private server?: http.Server;
  private port = 0;
  private severedOnce = false;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    this.port = (this.server!.address() as AddressInfo).port;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const range = req.headers["range"];
    const reqHeaders: Record<string, string> = { "user-agent": "qvac-e2e-proxy" };
    if (typeof range === "string") reqHeaders["range"] = range;

    let upstream: Awaited<ReturnType<typeof fetch>>;
    try {
      upstream = await fetch(`${HF_ORIGIN}${req.url}`, {
        method: req.method === "HEAD" ? "HEAD" : "GET",
        headers: reqHeaders,
      });
    } catch (err) {
      res.writeHead(502);
      res.end(err instanceof Error ? err.message : String(err));
      return;
    }

    const outHeaders: Record<string, string> = {
      "accept-ranges": upstream.headers.get("accept-ranges") ?? "bytes",
      "content-type":
        upstream.headers.get("content-type") ?? "application/octet-stream",
    };
    const cl = upstream.headers.get("content-length");
    if (cl) outHeaders["content-length"] = cl;
    const cr = upstream.headers.get("content-range");
    if (cr) outHeaders["content-range"] = cr;
    res.writeHead(upstream.status, outHeaders);

    if (req.method === "HEAD" || !upstream.body) {
      res.end();
      return;
    }

    // Sever the designated shard's first (Range-less) transfer exactly once;
    // the retry arrives with a Range header and is served to completion.
    const severThis =
      !range && !this.severedOnce && (req.url ?? "").includes(SHARD_TO_SEVER);

    let sent = 0;
    try {
      for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
        if (severThis && sent >= SHARD_SEVER_AT_BYTES) {
          this.severedOnce = true;
          res.destroy();
          return;
        }
        res.write(Buffer.from(chunk));
        sent += chunk.length;
      }
      res.end();
    } catch {
      res.destroy();
    }
  }

  async close(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
  }
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

export class DownloadResilienceExecutor extends BaseExecutor<typeof resilienceTests> {
  pattern = /^download-resilience-/;

  protected handlers = {
    [downloadResilienceRegistrySuspend.testId]: this.registrySuspend.bind(this),
    [downloadResilienceHttpNetdrop.testId]: this.httpNetdrop.bind(this),
    [downloadResilienceHttpSuspend.testId]: this.httpSuspend.bind(this),
    [downloadResilienceHttpSharded.testId]: this.httpSharded.bind(this),
  };

  /** registry:// download must survive suspend/resume and finish from the partial. */
  async registrySuspend(): Promise<TestResult> {
    // Excluded from default CI: only meaningful with a short registryStreamTimeoutMs
    // (fixtures/qvac.config.e2e.resilience.json). Run with:
    //   QVAC_CONFIG_PATH=fixtures/qvac.config.e2e.resilience.json \
    //   QVAC_E2E_P2P_RESILIENCE=1 \
    //   npx qvac-test run:local:desktop --filter download-resilience-registry
    if (!process.env["QVAC_E2E_P2P_RESILIENCE"]) {
      return {
        passed: true,
        skipped: true,
        output:
          "skipped: set QVAC_E2E_P2P_RESILIENCE=1 with fixtures/qvac.config.e2e.resilience.json (short registryStreamTimeoutMs) to run this live-P2P test",
      };
    }

    const models = await modelRegistryList();
    if (!models.length) {
      return { passed: false, output: "registry list returned no models" };
    }
    const inBand = models
      .filter((m) => m.expectedSize >= REGISTRY_MIN_BYTES && m.expectedSize <= REGISTRY_MAX_BYTES)
      .sort((a, b) => a.expectedSize - b.expectedSize);
    const chosen = inBand[0];
    if (!chosen) {
      return {
        passed: false,
        output: `no registry model in [${REGISTRY_MIN_BYTES}, ${REGISTRY_MAX_BYTES}] bytes to exercise mid-download`,
      };
    }
    const assetSrc = `registry://${chosen.registrySource}/${chosen.registryPath}`;

    // Force a cold download so the transfer is genuinely in-flight at suspend().
    try {
      fs.rmSync(singleFileCachePath(chosen.registryPath), { force: true });
    } catch {
      /* best effort */
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
          // Background long enough that the stalled stream passes its timeout,
          // then foreground. resume() is in finally so the runtime is always
          // restored even if the download has already rejected.
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
        `registry download (${chosen.name})`,
        op,
        REGISTRY_RESUME_TIMEOUT_MS,
      );
      if (!firstMidProgress) {
        return {
          passed: false,
          output: `could not exercise mid-download — "${chosen.name}" (${chosen.expectedSize} bytes) produced no in-flight progress (cached?)`,
        };
      }
      return {
        passed: true,
        output: `registry download "${chosen.name}" survived suspend/resume: ${assetId} (maxPct=${maxPct.toFixed(1)})`,
      };
    } catch (err) {
      return {
        passed: false,
        output: `registry download did not survive suspend/resume (maxPct=${maxPct.toFixed(1)}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    } finally {
      // Ensure suspend/resume completes before the next test, even on early reject.
      if (lifecycleDone) {
        try {
          await lifecycleDone;
        } catch {
          /* resume failure surfaces via ensureActive elsewhere */
        }
      }
    }
  }

  /** https:// download must recover from a mid-stream socket drop via range resume. */
  async httpNetdrop(): Promise<TestResult> {
    const server = new FlakyFileServer({ mode: "auto" });
    await server.start();
    let maxPct = 0;
    try {
      const op = downloadAsset({
        assetSrc: server.url,
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
    } finally {
      await server.close();
    }
  }

  /** https:// download must survive suspend/resume even when the socket dies on background. */
  async httpSuspend(): Promise<TestResult> {
    const server = new FlakyFileServer({ mode: "manual" });
    await server.start();
    let firstProgress = false;
    let maxPct = 0;
    let lifecycleDone: Promise<void> | null = null;
    try {
      const op = downloadAsset({
        assetSrc: server.url,
        onProgress: (p: { percentage: number }) => {
          maxPct = Math.max(maxPct, p.percentage);
          if (!firstProgress && p.percentage > 0 && p.percentage < 100) {
            firstProgress = true;
            lifecycleDone = (async () => {
              await suspend();
              // Model the OS killing the in-flight socket while backgrounded.
              server.sever();
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
      await server.close();
    }
  }

  /** Sharded https:// download must recover when one shard's transfer drops mid-stream. */
  async httpSharded(): Promise<TestResult> {
    // Gated: downloads a real (~hundreds of MB) sharded model through a proxy.
    //   QVAC_E2E_HTTP_SHARDED_RESILIENCE=1 npx qvac-test run:local:desktop \
    //     --filter download-resilience-http-sharded
    if (!process.env["QVAC_E2E_HTTP_SHARDED_RESILIENCE"]) {
      return {
        passed: true,
        skipped: true,
        output:
          "skipped: set QVAC_E2E_HTTP_SHARDED_RESILIENCE=1 to run (downloads a real sharded model through the severing proxy)",
      };
    }

    const proxy = new ShardSeverProxy();
    await proxy.start();
    // Random proxy port → unique shard cacheKey → cold download by construction.
    const assetSrc = `${proxy.baseUrl}${SHARDED_MODEL_PATH}`;
    let maxPct = 0;
    try {
      const assetId = await withTimeout(
        "http sharded download",
        downloadAsset({
          assetSrc,
          onProgress: (p: { percentage: number }) => {
            maxPct = Math.max(maxPct, p.percentage);
          },
        }),
        SHARDED_RESUME_TIMEOUT_MS,
      );
      return {
        passed: true,
        output: `sharded http download recovered from a mid-stream shard drop: ${assetId} (maxPct=${maxPct.toFixed(1)})`,
      };
    } catch (err) {
      return {
        passed: false,
        output: `sharded http download did not recover from a mid-stream shard drop (maxPct=${maxPct.toFixed(1)}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    } finally {
      await proxy.close();
    }
  }
}
