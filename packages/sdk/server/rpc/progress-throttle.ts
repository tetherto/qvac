export const PROGRESS_THROTTLE_MS = 150;
export const PROGRESS_MAX_PENDING = 100;

export type ProgressThrottle<T> = {
  push: (update: T) => void;
  flush: () => void;
};

export function createProgressThrottle<T>(
  writeBatch: (updates: T[]) => void,
  clock: () => number = Date.now,
  throttleMs: number = PROGRESS_THROTTLE_MS,
  maxPending: number = PROGRESS_MAX_PENDING,
): ProgressThrottle<T> {
  let lastWrite = 0;
  let pending: T[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flushPending() {
    if (pending.length === 0) return;
    lastWrite = clock();
    const batch = pending;
    pending = [];
    writeBatch(batch);
  }

  function push(update: T) {
    const now = clock();
    if (now - lastWrite >= throttleMs) {
      lastWrite = now;
      writeBatch([update]);
    } else {
      pending.push(update);
      if (pending.length >= maxPending) {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        flushPending();
        return;
      }
      if (!flushTimer) {
        flushTimer = setTimeout(
          () => {
            flushTimer = null;
            flushPending();
          },
          throttleMs - (now - lastWrite),
        );
      }
    }
  }

  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flushPending();
  }

  return { push, flush };
}
