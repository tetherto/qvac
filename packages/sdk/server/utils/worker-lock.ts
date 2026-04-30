import fs from "bare-fs";
import path from "bare-path";
import process from "bare-process";
import { getServerLogger } from "@/logging";
import { getQvacPath } from "@/server/utils/qvac-paths";

const logger = getServerLogger();

const LOCK_FILENAME = ".worker.lock";

interface LockFileContent {
  pid: number;
  startedAt: string;
}

function getLockFilePath(): string {
  return getQvacPath(LOCK_FILENAME);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockFile(lockPath: string): LockFileContent | null {
  try {
    if (!fs.existsSync(lockPath)) return null;
    const raw = fs.readFileSync(lockPath, "utf-8") as string;
    return JSON.parse(raw) as LockFileContent;
  } catch {
    return null;
  }
}

export function acquireWorkerLock(): void {
  const lockPath = getLockFilePath();
  const existing = readLockFile(lockPath);

  if (existing) {
    if (isProcessAlive(existing.pid)) {
      logger.warn(
        `Another worker (PID ${existing.pid}) is still running — lock file exists at ${lockPath}`,
      );
    } else {
      logger.warn(
        `Stale lock file detected (PID ${existing.pid} is dead, started ${existing.startedAt}). Removing.`,
      );
    }
  }

  const content: LockFileContent = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };

  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify(content));
    logger.debug(`Worker lock acquired (PID ${process.pid})`);
  } catch (error) {
    logger.error(
      "Failed to write worker lock file:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function releaseWorkerLock(): void {
  const lockPath = getLockFilePath();

  try {
    const existing = readLockFile(lockPath);
    if (existing && existing.pid === process.pid) {
      fs.unlinkSync(lockPath);
      logger.debug("Worker lock released");
    }
  } catch {
    // Best-effort — may already be gone
  }
}
