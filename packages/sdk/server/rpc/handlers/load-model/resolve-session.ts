import type { ModelProgressUpdate, ResolveContext } from "@/schemas";
import {
  resolveModelPath,
  resolveModelPathWithStats,
} from "@/server/rpc/handlers/load-model/resolve";
import { cancelTransfer } from "@/server/rpc/handlers/load-model/download-manager";
import type { ResolveResult, DownloadHooks } from "@/server/rpc/handlers/load-model/types";

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
  getPrimaryResult(): ResolveResult | undefined;
  cancelAll(): void;
}

export function createResolveSession(options: ResolveSessionOptions): ResolveSession {
  const { progressCallback, seed, profilingEnabled } = options;
  let primaryResult: ResolveResult | undefined;
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
      return result.path;
    }
    return resolveModelPath(modelSrc, progressCallback, seed, downloadHooks);
  }

  function resolveForPlugin(src: unknown) {
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

  function getPrimaryResult() {
    return primaryResult;
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
    getPrimaryResult,
    cancelAll,
  };
}
