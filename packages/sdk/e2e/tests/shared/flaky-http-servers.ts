import * as http from "node:http";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

// Deliberately minimal test doubles for the download-resilience tests — just
// enough to deliver a partial, drop the connection once, and serve the Range
// resume. Not a realistic file server.

const PAYLOAD_BYTES = 6 * 1024 * 1024;
const SEVER_AT_BYTES = Math.floor(PAYLOAD_BYTES / 3);

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
 * Serves one fixed payload with Range support and drops the connection once
 * after a partial, so a working range-resume recovers. "auto" drops itself right
 * after the partial (a mid-stream network drop); "manual" holds the partial open
 * until sever() (to coincide with suspend()).
 */
export class FlakyFileServer {
  private readonly payload = buildPayload(PAYLOAD_BYTES);
  private readonly mode: "auto" | "manual";
  private server?: http.Server;
  private port = 0;
  private severedOnce = false;
  private held: http.ServerResponse | null = null;

  constructor(opts: { mode: "auto" | "manual" }) {
    this.mode = opts.mode;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", () => resolve()));
    this.port = (this.server!.address() as AddressInfo).port;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/resilience-model.bin`;
  }

  /** Drops the connection held open in "manual" mode (call on suspend). */
  sever(): void {
    this.severedOnce = true;
    this.held?.destroy();
    this.held = null;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const total = this.payload.length;

    if (req.method === "HEAD") {
      res.writeHead(200, { "content-length": String(total), "accept-ranges": "bytes" });
      res.end();
      return;
    }

    const start = parseRangeStart(req.headers["range"] as string | undefined);

    // A resumed request (Range), or anything after the one drop, is served fully.
    if (start > 0 || this.severedOnce) {
      const slice = this.payload.subarray(start);
      res.writeHead(start > 0 ? 206 : 200, {
        "content-length": String(slice.length),
        "accept-ranges": "bytes",
        ...(start > 0 && { "content-range": `bytes ${start}-${total - 1}/${total}` }),
      });
      res.end(slice);
      return;
    }

    // First request: send a partial so the client records real progress, then
    // drop it — immediately for "auto", or on sever() for "manual".
    res.writeHead(200, { "content-length": String(total), "accept-ranges": "bytes" });
    res.write(this.payload.subarray(0, SEVER_AT_BYTES));
    if (this.mode === "auto") {
      this.severedOnce = true;
      res.destroy();
    } else {
      this.held = res;
    }
  }

  async close(): Promise<void> {
    this.held?.destroy();
    this.held = null;
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
  }
}

const HF_ORIGIN = "https://huggingface.co";
// One shard of the real model; the proxy derives the rest of the shard set from
// it. Exported so the test points its download at this path through the proxy.
export const SHARDED_MODEL_PATH =
  "/opaninakuffo/gte-large-fp16-sharded/resolve/main/gte-large_fp16-00003-of-00005.gguf";
const SHARD_TO_SEVER = "-00002-of-";
const SHARD_SEVER_AT_BYTES = 16 * 1024 * 1024;

// The proxy fronts exactly the shards of this one model. Build the upstream URLs
// from constants up front so the incoming request is only ever a lookup key — no
// request-derived string reaches fetch().
const SHARD_DIR = path.posix.dirname(SHARDED_MODEL_PATH);
const SHARD_TOTAL = 5;
const SHARD_UPSTREAM = new Map<string, string>(
  Array.from({ length: SHARD_TOTAL }, (_, i) => {
    const n = String(i + 1).padStart(5, "0");
    const file = `gte-large_fp16-${n}-of-${String(SHARD_TOTAL).padStart(5, "0")}.gguf`;
    return [file, `${HF_ORIGIN}${SHARD_DIR}/${file}`];
  }),
);

/**
 * Reverse proxy in front of the real sharded model on HuggingFace. It relays each
 * shard (forwarding Range) and severs one designated shard's transfer exactly
 * once mid-stream to simulate a network drop. The resumed (Range) request is
 * served to completion, so a working retry/resume recovers.
 */
export class ShardSeverProxy {
  private server?: http.Server;
  private port = 0;
  private severedOnce = false;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", () => resolve()));
    this.port = (this.server!.address() as AddressInfo).port;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const basename = path.posix.basename(new URL(req.url ?? "", "http://proxy").pathname);
    const upstreamUrl = SHARD_UPSTREAM.get(basename);
    if (!upstreamUrl) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    const range = req.headers["range"];
    const reqHeaders: Record<string, string> = { "user-agent": "qvac-e2e-proxy" };
    if (typeof range === "string") reqHeaders["range"] = range;

    let upstream: Awaited<ReturnType<typeof fetch>>;
    try {
      upstream = await fetch(upstreamUrl, {
        method: req.method === "HEAD" ? "HEAD" : "GET",
        headers: reqHeaders,
      });
    } catch (err) {
      console.warn("[shard-sever-proxy] upstream fetch failed:", err);
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("upstream fetch failed");
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
      !range && !this.severedOnce && basename.includes(SHARD_TO_SEVER);

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
