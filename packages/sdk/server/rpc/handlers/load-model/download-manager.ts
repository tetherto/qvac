import { type DownloadEntry } from "@/schemas";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

const activeDownloads = new Map<string, DownloadEntry>();
const clearCacheFlags = new Map<string, boolean>();

export function getActiveDownload(key: string): DownloadEntry | undefined {
  return activeDownloads.get(key);
}

export function registerDownload(key: string, entry: DownloadEntry): void {
  activeDownloads.set(key, entry);
}

export function unregisterDownload(key: string): void {
  activeDownloads.delete(key);
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

export function setClearCacheFlag(downloadKey: string, clearCache: boolean) {
  if (clearCache) {
    clearCacheFlags.set(downloadKey, true);
  } else {
    clearCacheFlags.delete(downloadKey);
  }
}

export function shouldClearCache(downloadKey: string): boolean {
  return clearCacheFlags.get(downloadKey) ?? false;
}

export function clearClearCacheFlag(downloadKey: string) {
  clearCacheFlags.delete(downloadKey);
}

export function createCancelFunction(downloadKey: string, clearCache = false) {
  return () => {
    const entry = getActiveDownload(downloadKey);
    if (!entry) {
      return;
    }

    // Set flag for the download handlers to check
    setClearCacheFlag(downloadKey, clearCache);

    entry.abortController.abort();
    unregisterDownload(downloadKey);
  };
}

export function cancelAllDownloads(): void {
  logger.info(`🧹 Cancelling ${activeDownloads.size} active downloads`);

  Array.from(activeDownloads.keys()).forEach((key) =>
    createCancelFunction(key)(),
  );
}

let isCleaningUp = false;

export async function cleanupDownloads(): Promise<void> {
  if (isCleaningUp) return;
  isCleaningUp = true;

  try {
    const downloadPromises = Array.from(activeDownloads.values()).map(
      (entry) => entry.promise.catch(() => {}), // Ignore errors, we're shutting down
    );

    cancelAllDownloads();

    if (downloadPromises.length > 0) {
      await Promise.allSettled(downloadPromises);
    }
  } catch (error) {
    logger.error("❌ Error during download cleanup:", error);
  }
}
