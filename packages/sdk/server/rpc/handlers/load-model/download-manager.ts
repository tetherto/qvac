import type { ModelProgressUpdate } from "@/schemas";
import { AbortController } from "bare-abort-controller";
import { DownloadCancelledError } from "@/utils/errors-server";
import { getServerLogger } from "@/logging";
import type { DownloadHooks } from "@/server/rpc/handlers/load-model/types";

const logger = getServerLogger();

export interface Subscriber {
  id: string;
  onProgress?: ((progress: ModelProgressUpdate) => void) | undefined;
  settled: boolean;
  resolve: (path: string) => void;
  reject: (error: unknown) => void;
  promise: Promise<string>;
}

export interface Transfer {
  downloadKey: string;
  abortController: AbortController;
  subscribers: Map<string, Subscriber>;
  lastProgress?: ModelProgressUpdate | undefined;
  downloadPromise?: Promise<string> | undefined;
  clearCache: boolean;
  cacheHit?: boolean;
}

export interface DownloadContext {
  broadcastProgress: (progress: ModelProgressUpdate) => void;
  signal: AbortSignal;
  shouldClearCache: () => boolean;
  setCacheHit: (cacheHit: boolean) => void;
}

export interface StartOrJoinResult {
  promise: Promise<string>;
  joined: boolean;
  getCacheHit: () => boolean | undefined;
}

const activeTransfers = new Map<string, Transfer>();
let nextSubscriberId = 0;

function createSubscriber(
  onProgress?: (progress: ModelProgressUpdate) => void,
): Subscriber {
  let resolve!: (path: string) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return {
    id: String(nextSubscriberId++),
    onProgress,
    settled: false,
    resolve,
    reject,
    promise,
  };
}

function settleSubscriber(
  subscriber: Subscriber,
  result: string | Error,
): void {
  if (subscriber.settled) return;
  subscriber.settled = true;
  if (result instanceof Error) {
    subscriber.reject(result);
  } else {
    subscriber.resolve(result);
  }
}

function deliverProgress(
  transfer: Transfer,
  subscriber: Subscriber,
  progress: ModelProgressUpdate,
): void {
  if (subscriber.settled || !subscriber.onProgress) return;

  try {
    subscriber.onProgress(progress);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));

    logger.warn("Progress callback threw; detaching subscriber", {
      downloadKey: transfer.downloadKey,
      subscriberId: subscriber.id,
      error,
    });

    settleSubscriber(subscriber, error);
    transfer.subscribers.delete(subscriber.id);
  }
}

function broadcastTransferProgress(
  transfer: Transfer,
  progress: ModelProgressUpdate,
): void {
  transfer.lastProgress = progress;

  for (const sub of Array.from(transfer.subscribers.values())) {
    deliverProgress(transfer, sub, progress);
  }
}

export function startOrJoinDownload(
  downloadKey: string,
  startDownload: (ctx: DownloadContext) => Promise<string>,
  onProgress?: (progress: ModelProgressUpdate) => void,
): StartOrJoinResult {
  const existing = activeTransfers.get(downloadKey);
  if (existing && !existing.abortController.signal.aborted) {
    logger.info(`📥 Reusing existing download for: ${downloadKey}`);
    const subscriber = createSubscriber(onProgress);
    existing.subscribers.set(subscriber.id, subscriber);

    if (existing.lastProgress) {
      deliverProgress(existing, subscriber, existing.lastProgress);
    }

    return {
      promise: subscriber.promise,
      joined: true,
      getCacheHit: () => existing.cacheHit,
    };
  }

  const abortController = new AbortController();
  const transfer: Transfer = {
    downloadKey,
    abortController,
    subscribers: new Map(),
    clearCache: false,
  };

  const initialSubscriber = createSubscriber(onProgress);
  transfer.subscribers.set(initialSubscriber.id, initialSubscriber);
  activeTransfers.set(downloadKey, transfer);

  const downloadPromise = startDownload({
    broadcastProgress: (progress) => {
      broadcastTransferProgress(transfer, progress);
    },
    signal: abortController.signal,
    shouldClearCache: () => transfer.clearCache,
    setCacheHit: (cacheHit: boolean) => {
      transfer.cacheHit = cacheHit;
    },
  });
  transfer.downloadPromise = downloadPromise;

  downloadPromise.then(
    (path) => {
      for (const sub of transfer.subscribers.values()) {
        settleSubscriber(sub, path);
      }
    },
    (error) => {
      const rejection =
        error instanceof Error ? error : new Error(String(error));
      for (const sub of transfer.subscribers.values()) {
        settleSubscriber(sub, rejection);
      }
    },
  ).finally(() => {
    if (activeTransfers.get(downloadKey) === transfer) {
      activeTransfers.delete(downloadKey);
    }
  });

  return {
    promise: initialSubscriber.promise,
    joined: false,
    getCacheHit: () => transfer.cacheHit,
  };
}

export function cancelTransfer(
  downloadKey: string,
  clearCache = false,
): void {
  const transfer = activeTransfers.get(downloadKey);
  if (!transfer) return;

  transfer.clearCache = clearCache;
  transfer.abortController.abort();

  for (const sub of transfer.subscribers.values()) {
    settleSubscriber(sub, new DownloadCancelledError());
  }
}

export function createHyperdriveDownloadKey(
  hyperdriveKey: string,
  modelFileName: string,
): string {
  return `${hyperdriveKey}:${modelFileName}`;
}

export function createHttpDownloadKey(url: string): string {
  return `http:${url}`;
}

export function createRegistryDownloadKey(
  registrySource: string,
  registryPath: string,
): string {
  return `registry:${registrySource}:${registryPath}`;
}

export function applyJoinedDownloadStats(
  result: StartOrJoinResult,
  hooks?: DownloadHooks,
): Promise<string> {
  if (!result.joined) return result.promise;

  return result.promise.then((path) => {
    const cacheHit = result.getCacheHit();

    if (cacheHit === true) {
      hooks?.markCacheHit?.();
    } else if (cacheHit === false) {
      hooks?.markCacheMiss?.();
      hooks?.markSharedTransfer?.();
    } else {
      hooks?.markSharedTransfer?.();
    }

    return path;
  });
}

export function cancelAllDownloads(): void {
  logger.info(`🧹 Cancelling ${activeTransfers.size} active downloads`);

  for (const key of Array.from(activeTransfers.keys())) {
    cancelTransfer(key);
  }
}

let isCleaningUp = false;

export async function cleanupDownloads(): Promise<void> {
  if (isCleaningUp) return;
  isCleaningUp = true;

  try {
    const downloadPromises = Array.from(activeTransfers.values())
      .filter((t) => t.downloadPromise !== undefined)
      .map((t) => t.downloadPromise!.catch(() => {}));

    cancelAllDownloads();

    if (downloadPromises.length > 0) {
      await Promise.allSettled(downloadPromises);
    }
  } catch (error) {
    logger.error("❌ Error during download cleanup:", error);
  }
}
