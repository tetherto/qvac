import type { ModelProgressUpdate, ResolveContext } from "@/schemas";
import {
  resolveModelPath,
  resolveModelPathWithStats,
} from "@/server/rpc/handlers/load-model/resolve";
import type { ResolveResult } from "./types";

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
}

export function createResolveSession(options: ResolveSessionOptions): ResolveSession {
  const { progressCallback, seed, profilingEnabled } = options;
  let primaryResult: ResolveResult | undefined;

  async function resolvePrimaryModelPath(modelSrc: unknown) {
    if (profilingEnabled) {
      const result = await resolveModelPathWithStats(
        modelSrc,
        progressCallback,
        seed,
      );
      primaryResult = result;
      return result.path;
    }
    return resolveModelPath(modelSrc, progressCallback, seed);
  }

  function resolveForPlugin(src: unknown) {
    return resolveModelPath(src, progressCallback, seed);
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

  return {
    resolvePrimaryModelPath,
    createResolveContext,
    getPrimaryResult,
  };
}
