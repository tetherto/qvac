import { loadModel, downloadAsset, unloadModel, cancel } from "@qvac/sdk";
import type { ModelConstant } from "@qvac/sdk";

type ModelConfig = Record<string, unknown>;
type ModelConfigResolver = () => Promise<ModelConfig>;

interface ModelDefinition {
  constant: ModelConstant;
  type: string;
  /** Static config or async resolver (cached per-dep) for runtime-only fields like RN asset URIs. */
  config?: ModelConfig | ModelConfigResolver;
  skipPreDownload?: boolean;
}

function isModelConstant(value: unknown): value is ModelConstant {
  if (value == null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.src === "string" &&
    typeof v.modelId === "string" &&
    typeof v.sha256Checksum === "string"
  );
}

/**
 * Recursively walks `value` and adds every `ModelConstant`-shaped object it
 * encounters to `out`, keyed by `modelId`. Used so a single definition with
 * companion models (e.g. chatterbox T3 + s3gen, whisper + VAD,
 * diffusion + VAE + LLM, bergamot pivot, ESRGAN upscaler) contributes its
 * full set to the pre-download list — not just the root `constant`.
 */
function collectModelConstants(
  value: unknown,
  out: Map<string, ModelConstant>,
  seen: WeakSet<object>,
): void {
  if (value == null || typeof value !== "object") return;
  if (isModelConstant(value)) {
    if (!out.has(value.modelId)) out.set(value.modelId, value);
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectModelConstants(item, out, seen);
    return;
  }
  for (const inner of Object.values(value as Record<string, unknown>)) {
    collectModelConstants(inner, out, seen);
  }
}

interface TrackedModel {
  modelId: string;
  dep: string;
  lastUsedAtTest: number;
}

export interface ResourceManagerOptions {
  /**
   * Milliseconds to sleep after a successful unloadModel() call inside
   * `evict()`. Lets the OS catch up on lazy page reclamation before the
   * next load starts allocating on top.
   *
   * Mobile (iOS) needs this — kernel doesn't release pages instantly when
   * a Bare worklet's V8 isolate destroys its handles, and the next test's
   * load can crash with EXC_CRASH/SIGABRT inside the GGML allocator if it
   * arrives at the still-resident-residue moment.
   *
   * Desktop doesn't need it — `unloadModel` over the IPC socket completes
   * with the worker process already having freed the memory, and the
   * kernel reclaims fast.
   *
   * Default 0 (off).
   */
  unloadSettleMs?: number;
}

export class ResourceManager {
  private definitions = new Map<string, ModelDefinition>();
  private resolvedConfigs = new Map<string, ModelConfig>();
  private models = new Map<string, TrackedModel>();
  private testCount = 0;
  private downloaded = false;
  private readonly unloadSettleMs: number;

  constructor(options: ResourceManagerOptions = {}) {
    this.unloadSettleMs = options.unloadSettleMs ?? 0;
  }

  private async resolveConfig(dep: string, def: ModelDefinition): Promise<ModelConfig | undefined> {
    if (typeof def.config !== "function") return def.config;
    const cached = this.resolvedConfigs.get(dep);
    if (cached) return cached;
    const resolved = await def.config();
    this.resolvedConfigs.set(dep, resolved);
    return resolved;
  }

  define(dep: string, definition: ModelDefinition) {
    this.definitions.set(dep, definition);
  }

  /**
   * Pre-download every model constant referenced by every registered
   * definition, including constants buried inside `config` (companion
   * models, pivot models, upscaler/VAE/projection/etc.). Per-test
   * `ensureLoaded` then mmaps from the already-cached files.
   *
   * Behaviour:
   *  - `options.allowedDeps`, if given, narrows the set of *root* defs
   *    that contribute constants to the pre-download list.
   *  - A root def with `skipPreDownload: true` contributes nothing — not
   *    its root `constant` and not anything its `config` references. A
   *    constant that is *also* referenced by a non-skipped def will still
   *    be downloaded via that other def.
   *  - Idempotent on `downloaded`. Pass the full filter on the first
   *    call; later calls with a different filter are a no-op.
   */
  async downloadAllOnce(
    log?: (msg: string) => void,
    options: { allowedDeps?: ReadonlySet<string> } = {},
  ): Promise<void> {
    if (this.downloaded) return;
    this.downloaded = true;

    const allowed = options.allowedDeps;
    const isAllowed = (dep: string) => allowed === undefined || allowed.has(dep);

    const allDefinitions = Array.from(this.definitions.entries());

    if (allowed !== undefined) {
      const filteredOut = allDefinitions.filter(([dep]) => !isAllowed(dep)).length;
      log?.(
        `🎯 Bootstrap dep-filter active: keeping ${allowed.size} dep(s); ${filteredOut} of ${allDefinitions.length} defined excluded`,
      );
    }

    const skipped = allDefinitions.filter(([dep, def]) => def.skipPreDownload && isAllowed(dep));
    if (skipped.length > 0) {
      log?.(
        `⏭️  Skipping ${skipped.length} def(s) marked skipPreDownload: ${skipped.map(([dep]) => dep).join(", ")}`,
      );
    }

    // Discover every constant referenced by every contributing def, keyed
    // by `modelId` so the same constant referenced by multiple defs (or
    // listed both as the root `constant` and inside `config`) is only
    // downloaded once.
    const contributors = allDefinitions.filter(
      ([dep, def]) => !def.skipPreDownload && isAllowed(dep),
    );
    const constants = new Map<string, ModelConstant>();
    const owners = new Map<string, string[]>();
    const addConstant = (c: ModelConstant, dep: string) => {
      if (!constants.has(c.modelId)) constants.set(c.modelId, c);
      const list = owners.get(c.modelId) ?? [];
      if (!list.includes(dep)) list.push(dep);
      owners.set(c.modelId, list);
    };

    for (const [dep, def] of contributors) {
      addConstant(def.constant, dep);
      const cfg = await this.resolveConfig(dep, def);
      if (cfg) {
        const found = new Map<string, ModelConstant>();
        collectModelConstants(cfg, found, new WeakSet<object>());
        for (const c of found.values()) addConstant(c, dep);
      }
    }

    const downloadList = Array.from(constants.values());
    log?.(
      `📥 Pre-downloading ${downloadList.length} unique model constant(s) from ${contributors.length} def(s) in parallel...`,
    );

    const active = new Set<string>();
    let leftToCheck = downloadList.length;
    let maxConcurrent = 0;
    let parallelDetected = false;

    const results = await Promise.allSettled(
      downloadList.map(async (constant) => {
        const ownerLabel = (owners.get(constant.modelId) ?? []).join(",") || "?";
        log?.(`📥 ${constant.name} (used by: ${ownerLabel})...`);
        await downloadAsset({
          assetSrc: constant as never,
          onProgress: () => {
            active.add(constant.modelId);
            if (active.size > maxConcurrent) {
              maxConcurrent = active.size;
            }
            if (!parallelDetected && active.size >= 2) {
              parallelDetected = true;
              const names = Array.from(active)
                .map((id) => constants.get(id)?.name ?? id)
                .join(", ");
              log?.(`🔀 Parallel downloads confirmed (active: ${names})`);
            }
          },
        });
        active.delete(constant.modelId);
        leftToCheck--;
        log?.(`✅ ${constant.name} cached - still processing: ${leftToCheck}`);
        return constant.modelId;
      }),
    );

    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      for (const f of failed) {
        log?.(`❌ download failed: ${(f as PromiseRejectedResult).reason}`);
      }
      throw new Error(`${failed.length}/${downloadList.length} downloads failed`);
    }

    log?.(
      `📦 All ${downloadList.length} constant(s) pre-cached (max concurrent: ${maxConcurrent})`,
    );
  }

  setTestCount(n: number) {
    this.testCount = n;
  }

  incrementTestCount() {
    this.testCount++;
  }

  async ensureLoaded(dep: string): Promise<string> {
    const existing = this.models.get(dep);
    if (existing) {
      existing.lastUsedAtTest = this.testCount;
      return existing.modelId;
    }

    const def = this.definitions.get(dep);
    if (!def) throw new Error(`Unknown dependency: ${dep}`);

    const modelId = await loadModel({
      modelSrc: def.constant as never,
      modelType: def.type as "llm" | "whisper" | "embeddings",
      modelConfig: await this.resolveConfig(dep, def),
    });

    this.models.set(dep, {
      modelId,
      dep,
      lastUsedAtTest: this.testCount,
    });

    return modelId;
  }

  /**
   * Register a model with the resource manager. To be called after loadModel has been called.
   */
  register(dep: string, modelId: string) {
    this.models.set(dep, { modelId, dep, lastUsedAtTest: this.testCount });
  }

  /**
   * Unregister a model from the resource manager. To be called after unloadModel has been called.
   */
  unregister(modelId: string): void {
    const matches = Array.from(this.models.entries()).filter(([_, entry]) => entry.modelId === modelId);
    for (const [dep] of matches) {
      this.models.delete(dep);
    }
  }

  getModelId(dep: string): string | null {
    return this.models.get(dep)?.modelId ?? null;
  }

  async evictExcept(keep: string[]): Promise<string[]> {
    const keepSet = new Set(keep);
    const evicted: string[] = [];
    for (const dep of this.models.keys()) {
      if (!keepSet.has(dep)) {
        await this.evict(dep);
        evicted.push(dep);
      }
    }
    return evicted;
  }

  async evictStale(threshold: number): Promise<string[]> {
    console.info(`🧹 Evicting stale models (test count: ${this.testCount}, threshold: ${threshold})`);
    const evicted: string[] = [];
    for (const [dep, entry] of this.models) {
      if (this.testCount - entry.lastUsedAtTest >= threshold) {
        await this.evict(dep);
        evicted.push(dep);
      }
    }
    return evicted;
  }

  async evict(dep: string): Promise<void> {
    const entry = this.models.get(dep);
    if (entry) {
      console.info(`🧹 Evicting model ${dep} (test count: ${this.testCount}, last used at test: ${entry.lastUsedAtTest})`);
      try {
        await cancel({ operation: "inference", modelId: entry.modelId });
      } catch (error) {
        console.debug(`Error canceling inference ${dep}: ${error}`);
      }
      try {
        await unloadModel({ modelId: entry.modelId });
        // Optionally yield so the OS can reclaim pages before the next
        // load starts allocating. See `unloadSettleMs` docs above. Only
        // wait when the unload actually succeeded; on failure there's
        // nothing to settle.
        if (this.unloadSettleMs > 0) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, this.unloadSettleMs),
          );
        }
      } catch (error) {
        console.warn(`Error unloading model ${dep}: ${error}`);
      }

      this.models.delete(dep);
    }
  }

  async evictAll(): Promise<void> {
    for (const dep of this.models.keys()) {
      await this.evict(dep);
    }
    this.models.clear();
  }
}
