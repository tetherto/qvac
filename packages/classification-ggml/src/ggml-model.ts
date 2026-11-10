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
  type StereoDepthJob,
} from "./addon";
import type { ImageClassifierLogger } from "./index";

/** Options shared by the GGUF models loaded through the native addon. */
export interface GgmlModelOptions {
  /** Local GGUF weights. Weights are not bundled. */
  modelPath: string;
  /** Exact GGML device name, such as CPU, CUDA0 or Vulkan0. Default: GPU, then CPU. */
  backend?: string;
  threads?: number;
  backendsDir?: string;
  logger?: ImageClassifierLogger;
}

/** Raw RGB dimensions of an input. Omit for JPEG/PNG input. */
export interface RawRgbOptions {
  width: number;
  height: number;
  channels: 3;
}

export interface GgmlRuntimeStats {
  total_time_ms?: number;
  /** CPU=0, Metal=1, CUDA=2, Vulkan=3, OpenCL=4, other=99. */
  backend_id?: number;
  cpu_fallback_nodes?: number;
  weight_bytes?: number;
}

const STAT_KEYS = ["total_time_ms", "backend_id", "cpu_fallback_nodes", "weight_bytes"] as const;
/** Upper bound for the `threads` option. */
const MAX_THREADS = 1024;

/**
 * Lifecycle shared by MegaLoc and BridgeDepth: option checks, lazy native load,
 * one job at a time, runtime stats, unload and destroy. A subclass names the
 * model and implements its own inference call on top of `runJob()`.
 */
export abstract class GgmlModel {
  readonly logger: ImageClassifierLogger;
  private addon: ClassificationInterface | null = null;
  private readonly job = createJobHandler({ cancel: () => this.addon?.cancel() });
  private readonly exclusive = exclusiveRunQueue();
  private destroyed = false;
  private stats: GgmlRuntimeStats = {};
  private readonly options: GgmlModelOptions;

  /** `name` starts every error message; `modelType` selects the native model. */
  protected constructor(
    private readonly name: string,
    private readonly modelType: "megaloc" | "bridgedepth",
    options: GgmlModelOptions,
  ) {
    if (!options || typeof options.modelPath !== "string" || !options.modelPath) {
      throw new TypeError(`${name} modelPath is required`);
    }
    if (options.threads !== undefined &&
        (!Number.isInteger(options.threads) || options.threads < 1 || options.threads > MAX_THREADS)) {
      throw new RangeError(`${name} threads must be an integer between 1 and ${MAX_THREADS}`);
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
      if (this.destroyed) throw new Error(`${this.name} has been destroyed`);
      if (this.addon) return;
      if (!fs.existsSync(this.options.modelPath)) {
        throw new Error(`${this.name} GGUF weights not found at: ${this.options.modelPath}`);
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is loaded lazily.
      const binding = require("./binding") as ClassificationBinding;
      let addon: ClassificationInterface | null = null;
      try {
        addon = new ClassificationInterface(
          binding,
          { path: this.options.modelPath, modelType: this.modelType, config: {
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

  /**
   * Runs one job and returns `extract()` of what the addon emitted.
   * `jobName` names the job in the rejection message; `extract` returns null
   * for an output of the wrong shape, which rejects with `invalidMessage`.
   */
  protected runJob<T>(
    input: ImageEmbeddingJob | StereoDepthJob,
    jobName: string,
    extract: (collected: unknown) => T | null,
    invalidMessage: string,
  ): Promise<T> {
    return this.exclusive(async () => {
      if (!this.addon) throw new Error(`${this.name} is not loaded. Call load() first.`);
      this.stats = {};
      const response = this.job.start();
      const pending = response.await();
      try {
        const accepted = await this.addon.runJob(input);
        if (!accepted) throw new Error(`${jobName} was rejected`);
      } catch (error) {
        this.job.fail(error as Error);
      }
      const result = extract(await pending);
      if (result === null) throw new Error(invalidMessage);
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
        for (const key of STAT_KEYS) {
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

/** Copies the raw RGB dimensions onto a job; JPEG/PNG input passes none. */
export function withRawRgb<J extends ImageEmbeddingJob | StereoDepthJob>(input: J, options?: RawRgbOptions): J {
  if (options) {
    if (options.width !== undefined) input.width = options.width;
    if (options.height !== undefined) input.height = options.height;
    if (options.channels !== undefined) input.channels = options.channels;
  }
  return input;
}
