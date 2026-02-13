import { execSync } from "child_process";

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

export function getCommitHash(short = false): string {
  try {
    const cmd = short ? "git rev-parse --short HEAD" : "git rev-parse HEAD";
    return execSync(cmd, { encoding: "utf-8" }).trim();
  } catch (error) {
    throw new Error("Git is required to generate history file", {
      cause: error,
    });
  }
}
