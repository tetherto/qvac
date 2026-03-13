import { loadModel, downloadAsset, unloadModel, cancel } from "@qvac/sdk";
import type { ModelConstant } from "@qvac/sdk";

interface ModelDefinition {
  constant: ModelConstant;
  type: string;
  config?: Record<string, unknown>;
  skipPreDownload?: boolean;
}

interface TrackedModel {
  modelId: string;
  dep: string;
  lastUsedAtTest: number;
}

export class ResourceManager {
  private definitions = new Map<string, ModelDefinition>();
  private models = new Map<string, TrackedModel>();
  private testCount = 0;
  private downloaded = false;

  define(dep: string, definition: ModelDefinition) {
    this.definitions.set(dep, definition);
  }

  async downloadAllOnce(log?: (msg: string) => void): Promise<void> {
    if (this.downloaded) return;
    this.downloaded = true;

    const entries = Array.from(this.definitions.entries());
    log?.(`📥 Downloading ${entries.length} models...`);

    // Sequential — SDK p2p downloads don't handle parallel well
    for (const [dep, def] of entries) {
      if (def.skipPreDownload) {
        log?.(`⏭️  ${dep}: skipping pre-download`);
        continue;
      }
      log?.(`📥 ${dep}: ${def.constant.name}...`);
      await downloadAsset({ assetSrc: def.constant as never });
      log?.(`✅ ${dep} cached`);
    }

    log?.(`📦 All ${entries.length} models pre-cached`);
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
      modelConfig: def.config,
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
