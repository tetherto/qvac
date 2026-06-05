import type { AbortSignal } from "bare-abort-controller";
import type { ModelProgressUpdate, ResolveContext } from "@/schemas";
import {
  resolveModelPath,
  resolveModelPathWithStats,
} from "@/server/rpc/handlers/load-model/resolve";
import { cancelTransfer } from "@/server/rpc/handlers/load-model/download-manager";
import type {
  DownloadRequestBinding,
  ResolveResult,
  DownloadHooks,
} from "@/server/rpc/handlers/load-model/types";
import { mergeDownloadStats } from "@/server/rpc/handlers/load-model/download-stats";

export interface ResolveSessionOptions {
  progressCallback?: ((update: ModelProgressUpdate) => void) | undefined;
  seed?: boolean | undefined;
  profilingEnabled: boolean;
  /**
   * Optional cancel signal — typically `ctx.signal` from the surrounding
   * `await using ctx = await registry.begin(...)` block. When provided,
   * `resolveModelPath` short-circuits with `InferenceCancelledError` if the
   * signal is already aborted on entry; the same signal also propagates
   * to in-progress transfers via the request binding below so cancel
   * tears them down end-to-end.
   */
  signal?: AbortSignal | undefined;
  /**
   * Optional per-request binding threaded into every `startOrJoinDownload`
   * call. The download manager wires a per-subscriber abort listener
   * against `binding.signal`, registers a scope-defer cleanup, and stamps
   * the subscriber with `binding.requestId` so the legacy
   * `cancelTransfer(downloadKey)` path can route through
   * `registry.cancel({ requestId })`.
   */
  requestBinding?: DownloadRequestBinding | undefined;
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
  const { progressCallback, seed, profilingEnabled, signal, requestBinding } =
    options;
  let primaryResult: ResolveResult | undefined;
  const resolveResults: ResolveResult[] = [];
  const activeDownloadKeys = new Set<string>();

  const downloadHooks: DownloadHooks = {
    onDownloadKey(key: string) {
      activeDownloadKeys.add(key);
    },
    ...(requestBinding !== undefined && { requestBinding }),
  };

  async function resolvePrimaryModelPath(modelSrc: unknown) {
    if (profilingEnabled) {
      const result = await resolveModelPathWithStats(
        modelSrc,
        progressCallback,
        seed,
        signal,
        downloadHooks,
      );
      primaryResult = result;
      resolveResults.push(result);
      return result.path;
    }
    return resolveModelPath(
      modelSrc,
      progressCallback,
      seed,
      signal,
      downloadHooks,
    );
  }

  async function resolveForPlugin(src: unknown) {
    if (profilingEnabled) {
      const result = await resolveModelPathWithStats(
        src,
        progressCallback,
        seed,
        signal,
        downloadHooks,
      );
      resolveResults.push(result);
      return result.path;
    }
    return resolveModelPath(
      src,
      progressCallback,
      seed,
      signal,
      downloadHooks,
    );
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
