import type { ModelProgressUpdate, ResolveContext } from "@/schemas";
import {
  resolveModelPath,
  resolveModelPathWithStats,
} from "@/server/rpc/handlers/load-model/resolve";
import { cancelTransfer } from "@/server/rpc/handlers/load-model/download-manager";
import type {
  ResolveResult,
  DownloadHooks,
} from "@/server/rpc/handlers/load-model/types";
import { mergeDownloadStats } from "@/server/rpc/handlers/load-model/download-stats";

export interface ResolveSessionOptions {
  progressCallback?: ((update: ModelProgressUpdate) => void) | undefined;
  seed?: boolean | undefined;
  profilingEnabled: boolean;
}

export interface ResolveSession {
  resolvePrimaryModelPath(modelSrc: unknown): Promise<string>;
  createResolveContext(
    modelSrc: string,
    modelType: string,
    modelName?: string,
  ): ResolveContext;
  getAggregateResult(): ResolveResult | undefined;
  cancelAll(): void;
}

export function createResolveSession(options: ResolveSessionOptions): ResolveSession {
  const { progressCallback, seed, profilingEnabled } = options;
  let primaryResult: ResolveResult | undefined;
  const resolveResults: ResolveResult[] = [];
  const activeDownloadKeys = new Set<string>();

  const downloadHooks: DownloadHooks = {
    onDownloadKey(key: string) {
      activeDownloadKeys.add(key);
    },
  };

  async function resolvePrimaryModelPath(modelSrc: unknown) {
    if (profilingEnabled) {
      const result = await resolveModelPathWithStats(
        modelSrc,
        progressCallback,
        seed,
        downloadHooks,
      );
      primaryResult = result;
      resolveResults.push(result);
      return result.path;
    }
    return resolveModelPath(modelSrc, progressCallback, seed, downloadHooks);
  }

  async function resolveForPlugin(src: unknown) {
    if (profilingEnabled) {
      const result = await resolveModelPathWithStats(
        src,
        progressCallback,
        seed,
        downloadHooks,
      );
      resolveResults.push(result);
      return result.path;
    }
    return resolveModelPath(src, progressCallback, seed, downloadHooks);
  }

  function createResolveContext(
    modelSrc: string,
    modelType: string,
    modelName?: string,
  ): ResolveContext {
    return {
      resolveModelPath: resolveForPlugin,
      modelSrc,
      modelType,
      ...(modelName !== undefined && { modelName }),
    };
  }

  function getAggregateResult(): ResolveResult | undefined {
    if (!profilingEnabled || resolveResults.length === 0) return undefined;

    const downloadStats = mergeDownloadStats(resolveResults);
    return {
      path: primaryResult?.path ?? resolveResults[0]!.path,
      sourceType: primaryResult?.sourceType ?? resolveResults[0]!.sourceType,
      ...(downloadStats !== undefined && { downloadStats }),
    };
  }

  function cancelAll() {
    for (const key of activeDownloadKeys) {
      cancelTransfer(key);
    }
    activeDownloadKeys.clear();
  }

  return {
    resolvePrimaryModelPath,
    createResolveContext,
    getAggregateResult,
    cancelAll,
  };
}
