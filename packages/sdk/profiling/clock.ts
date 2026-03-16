/**
 * Runtime-safe monotonic clock for profiling.
 * Priority: performance.now > process.hrtime > Date.now
 */

export type ClockSource = "performance" | "hrtime" | "date";

let clockSource: ClockSource;
let nowMsImpl: () => number;

// Detect and cache the best available clock source at module load
if (
  typeof globalThis !== "undefined" &&
  typeof globalThis.performance !== "undefined" &&
  typeof globalThis.performance.now === "function"
) {
  clockSource = "performance";
  const perfNow = globalThis.performance.now.bind(globalThis.performance);
  nowMsImpl = () => perfNow();
} else if (
  typeof process !== "undefined" &&
  typeof process.hrtime === "function" &&
  typeof process.hrtime.bigint === "function"
) {
  clockSource = "hrtime";
  const hrtime = process.hrtime.bigint.bind(process.hrtime);
  const startNs = hrtime();
  nowMsImpl = () => Number(hrtime() - startNs) / 1_000_000;
} else {
  clockSource = "date";
  const startMs = Date.now();
  nowMsImpl = () => Date.now() - startMs;
}

export function getClockSource(): ClockSource {
  return clockSource;
}

export function isMonotonic(): boolean {
  return clockSource === "performance" || clockSource === "hrtime";
}

export function nowMs(): number {
  return nowMsImpl();
}

export async function measureAsync<T>(
  fn: () => Promise<T>,
): Promise<[T, number]> {
  const start = nowMs();
  const result = await fn();
  return [result, nowMs() - start];
}

export function measureSync<T>(fn: () => T): [T, number] {
  const start = nowMs();
  const result = fn();
  return [result, nowMs() - start];
}

export function generateProfileId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${timestamp}-${random}`;
}
