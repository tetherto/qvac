/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS exports. */
import fs = require("bare-fs");
import QvacLogger = require("@qvac/logging");
/* eslint-enable @typescript-eslint/no-require-imports */
import { createJobHandler, exclusiveRunQueue } from "@qvac/infer-base";
import {
  ClassificationInterface,
  mapAddonEvent,
  type ClassificationBinding,
  type ImageEmbeddingJob,
} from "./addon";
import type { ImageClassifierLogger } from "./index";

export interface MegaLocOptions {
  /** Local F16 or F16 body + Q6_K projection GGUF. Weights are not bundled. */
  modelPath: string;
  /** Exact GGML device name, such as CPU, CUDA0 or Vulkan0. Default: GPU, then CPU. */
  backend?: string;
  threads?: number;
  backendsDir?: string;
  logger?: ImageClassifierLogger;
}

export interface ImageEmbeddingOptions {
  width: number;
  height: number;
  channels: 3;
}

export interface MegaLocRuntimeStats {
  total_time_ms?: number;
  /** CPU=0, Metal=1, CUDA=2, Vulkan=3, OpenCL=4, other=99. */
  backend_id?: number;
  cpu_fallback_nodes?: number;
  weight_bytes?: number;
}

/** Produces an 8,448-element, L2-normalized visual place descriptor. */
export class MegaLoc {
  readonly logger: ImageClassifierLogger;
  private addon: ClassificationInterface | null = null;
  private readonly job = createJobHandler({ cancel: () => this.addon?.cancel() });
  private readonly exclusive = exclusiveRunQueue();
  private destroyed = false;
  private stats: MegaLocRuntimeStats = {};

  constructor(private readonly options: MegaLocOptions) {
    if (!options || typeof options.modelPath !== "string" || !options.modelPath) {
      throw new TypeError("MegaLoc modelPath is required");
    }
    if (options.threads !== undefined &&
        (!Number.isInteger(options.threads) || options.threads < 1 || options.threads > 1024)) {
      throw new RangeError("MegaLoc threads must be an integer between 1 and 1024");
    }
    this.options = { ...options };
    this.logger = new QvacLogger(options.logger as QvacLogger.LoggerInterface);
  }

  getState() {
    return { configLoaded: this.addon !== null, destroyed: this.destroyed };
  }

  getRuntimeStats() {
    return { ...this.stats };
  }

  load(): Promise<void> {
    return this.exclusive(async () => {
      if (this.destroyed) throw new Error("MegaLoc has been destroyed");
      if (this.addon) return;
      if (!fs.existsSync(this.options.modelPath)) {
        throw new Error(`MegaLoc GGUF weights not found at: ${this.options.modelPath}`);
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is loaded lazily.
      const binding = require("./binding") as ClassificationBinding;
      let addon: ClassificationInterface | null = null;
      try {
        addon = new ClassificationInterface(
          binding,
          { path: this.options.modelPath, modelType: "megaloc", config: {
            backend: this.options.backend,
            threads: this.options.threads,
            backendsDir: this.options.backendsDir,
          } },
          (_owner, event, data, error) => this.onEvent(event, data, error),
          this.logger,
          { disableNativeLogger: true },
        );
        await addon.activate();
        this.addon = addon;
      } catch (error) {
        await addon?.unload();
        throw error;
      }
    });
  }

  embed(image: Uint8Array, options?: ImageEmbeddingOptions): Promise<Float32Array> {
    return this.exclusive(async () => {
      if (!this.addon) throw new Error("MegaLoc is not loaded. Call load() first.");
      const input: ImageEmbeddingJob = { type: "embedding", content: image };
      if (options) {
        if (options.width !== undefined) input.width = options.width;
        if (options.height !== undefined) input.height = options.height;
        if (options.channels !== undefined) input.channels = options.channels;
      }
      this.stats = {};
      const response = this.job.start();
      const pending = response.await();
      try {
        const accepted = await this.addon.runJob(input);
        if (!accepted) throw new Error("MegaLoc embedding job was rejected");
      } catch (error) {
        this.job.fail(error as Error);
      }
      const collected: unknown = await pending;
      const result: unknown = Array.isArray(collected) ? collected[0] : collected;
      if (!(result instanceof Float32Array) || result.length !== 8448) {
        throw new Error("MegaLoc returned an invalid descriptor");
      }
      return result;
    });
  }

  private onEvent(event: unknown, data: unknown, error: unknown) {
    const mapped = mapAddonEvent(event, data, error);
    if (!mapped) return;
    if (mapped.type === "Error") {
      this.job.fail(error instanceof Error ? error : new Error(String(error)));
    } else if (mapped.type === "Output") {
      this.job.output(mapped.data);
    } else if (mapped.type === "JobEnded") {
      if (data && typeof data === "object") {
        const values = data as Record<string, unknown>;
        this.stats = {};
        for (const key of ["total_time_ms", "backend_id", "cpu_fallback_nodes", "weight_bytes"] as const) {
          if (typeof values[key] === "number") this.stats[key] = values[key];
        }
      }
      this.job.end();
    }
  }

  private async release() {
    if (this.addon) {
      await this.addon.cancel();
      await this.addon.unload();
      this.addon = null;
    }
    this.stats = {};
  }

  unload(): Promise<void> {
    return this.exclusive(() => this.release());
  }

  destroy(): Promise<void> {
    return this.exclusive(async () => {
      await this.release();
      this.destroyed = true;
    });
  }
}
