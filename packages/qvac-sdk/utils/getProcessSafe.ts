import { detectRuntime } from "@/utils/runtime";

export async function getProcessSafe(): Promise<
  | {
      cwd?: () => string;
      env?: Record<string, string | undefined>;
      platform?: string;
      exit?: (code: number) => void;
    }
  | undefined
> {
  const runtime = detectRuntime();

  if (runtime === "bare") {
    try {
      const bareProcess = await import("bare-process");
      return bareProcess.default;
    } catch {
      return undefined;
    }
  }

  if (typeof process !== "undefined") {
    return process;
  }

  return undefined;
}
