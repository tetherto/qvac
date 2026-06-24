export type BootstrapDownloadTarget = "desktop" | "mobile";

export interface BootstrapDownloadEnv {
  QVAC_E2E_DOWNLOAD_CONCURRENCY?: string;
}

export interface BootstrapDownloadItem {
  id: string;
  name: string;
  ownerLabel: string;
  run: () => Promise<void>;
}

export interface BootstrapDownloadOptions {
  concurrency: number;
  retryConcurrency: number;
  log?: (message: string) => void;
}

export interface BootstrapDownloadResult {
  maxConcurrent: number;
}

interface FailedDownload {
  item: BootstrapDownloadItem;
  reason: unknown;
}

interface QueueState {
  nextIndex: number;
}

const DEFAULT_DOWNLOAD_CONCURRENCY: Record<BootstrapDownloadTarget, number> = {
  desktop: 6,
  mobile: 4,
};

function positiveIntegerOrNull(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}

function normalizeConcurrency(value: number, fallback: number) {
  if (!Number.isInteger(value) || value < 1) return fallback;
  return value;
}

export function resolveBootstrapDownloadConcurrency(
  env: BootstrapDownloadEnv = {},
  target: BootstrapDownloadTarget = "desktop",
) {
  return (
    positiveIntegerOrNull(env.QVAC_E2E_DOWNLOAD_CONCURRENCY) ??
    DEFAULT_DOWNLOAD_CONCURRENCY[target]
  );
}

export function resolveBootstrapRetryConcurrency(concurrency: number) {
  return Math.min(2, Math.max(1, concurrency));
}

async function runQueueWorker<T>(
  items: readonly T[],
  results: PromiseSettledResult<void>[],
  state: QueueState,
  worker: (item: T) => Promise<void>,
) {
  while (state.nextIndex < items.length) {
    const index = state.nextIndex;
    state.nextIndex++;
    try {
      await worker(items[index]);
      results[index] = { status: "fulfilled", value: undefined };
    } catch (reason) {
      results[index] = { status: "rejected", reason };
    }
  }
}

async function mapSettledWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
) {
  const results = new Array<PromiseSettledResult<void>>(items.length);
  const state: QueueState = { nextIndex: 0 };

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, () =>
      runQueueWorker(items, results, state, worker),
    ),
  );
  return results;
}

function collectFailures(
  items: readonly BootstrapDownloadItem[],
  results: readonly PromiseSettledResult<void>[],
) {
  const failed: FailedDownload[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "rejected") {
      failed.push({ item: items[i], reason: result.reason });
    }
  }
  return failed;
}

function formatReason(reason: unknown) {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

export async function runBootstrapDownloads(
  items: readonly BootstrapDownloadItem[],
  options: BootstrapDownloadOptions,
) {
  const concurrency = normalizeConcurrency(
    options.concurrency,
    DEFAULT_DOWNLOAD_CONCURRENCY.desktop,
  );
  const retryConcurrency = normalizeConcurrency(
    options.retryConcurrency,
    resolveBootstrapRetryConcurrency(concurrency),
  );
  const log = options.log;
  let active = 0;
  let maxConcurrent = 0;
  let leftToCheck = items.length;
  let parallelDetected = false;

  async function runItem(item: BootstrapDownloadItem, retry: boolean) {
    const prefix = retry ? "🔁 retry" : "📥";
    log?.(`${prefix} ${item.name} (used by: ${item.ownerLabel})...`);
    active++;
    maxConcurrent = Math.max(maxConcurrent, active);
    if (!parallelDetected && active >= 2) {
      parallelDetected = true;
      log?.(`🔀 Parallel downloads confirmed (active: ${active})`);
    }
    try {
      await item.run();
      leftToCheck--;
      log?.(`✅ ${item.name} cached - still processing: ${leftToCheck}`);
    } finally {
      active--;
    }
  }

  const firstPassResults = await mapSettledWithConcurrency(
    items,
    concurrency,
    (item) => runItem(item, false),
  );
  const firstPassFailed = collectFailures(items, firstPassResults);
  if (firstPassFailed.length === 0) return { maxConcurrent };

  for (const failure of firstPassFailed) {
    log?.(
      `❌ download failed: ${failure.item.name}: ${formatReason(failure.reason)}`,
    );
  }

  log?.(
    `🔁 Retrying ${firstPassFailed.length} failed download(s) with concurrency ${retryConcurrency}`,
  );

  const retryItems = firstPassFailed.map((failure) => failure.item);
  const retryResults = await mapSettledWithConcurrency(
    retryItems,
    retryConcurrency,
    (item) => runItem(item, true),
  );
  const finalFailed = collectFailures(retryItems, retryResults);
  if (finalFailed.length > 0) {
    for (const failure of finalFailed) {
      log?.(
        `❌ retry failed: ${failure.item.name}: ${formatReason(failure.reason)}`,
      );
    }
    throw new Error(
      `${finalFailed.length}/${items.length} downloads failed after retry pass`,
    );
  }

  return { maxConcurrent };
}
