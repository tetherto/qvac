// Discovery + kill helpers for bare worker children. Mirrors
// e2e/tests/desktop/executors/no-lingering-bare-executor.ts — dedup
// blocked by the e2e harness's separate BaseExecutor setup.

import { execFileSync } from "node:child_process";

const POLL_INTERVAL_MS = 50;
const BARE_DISCOVERY_TIMEOUT_MS = 5_000;

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function findBareChildrenPosix(parentPid: number): number[] {
  let pgrepOutput: string;
  try {
    pgrepOutput = execFileSync("pgrep", ["-P", String(parentPid)], {
      encoding: "utf-8",
    });
  } catch (error: unknown) {
    // pgrep exits 1 when no children match.
    if ((error as { status?: number })?.status === 1) return [];
    throw error;
  }

  const childPids = pgrepOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(Number);

  const bare: number[] = [];
  for (const pid of childPids) {
    try {
      const comm = execFileSync("ps", ["-o", "comm=", "-p", String(pid)], {
        encoding: "utf-8",
      }).trim();
      if (comm.endsWith("bare")) {
        bare.push(pid);
      }
    } catch {}
  }
  return bare;
}

function findBareChildrenWin32(parentPid: number): number[] {
  let psOutput: string;
  try {
    psOutput = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid}" ` +
          `| ForEach-Object { "$($_.ProcessId)|$($_.Name)" }`,
      ],
      { encoding: "utf-8" },
    );
  } catch (error: unknown) {
    const code = (error as { code?: string })?.code;
    if (code === "ENOENT") throw new Error("powershell.exe not found in PATH");
    const msg = (error as { stderr?: string })?.stderr ?? String(error);
    throw new Error(`PowerShell query failed: ${msg}`);
  }

  const bare: number[] = [];
  for (const line of psOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf("|");
    if (sep === -1) continue;
    const pid = Number(trimmed.slice(0, sep));
    const name = trimmed.slice(sep + 1).toLowerCase();
    if (Number.isNaN(pid)) continue;
    if (name === "bare" || name === "bare.exe") {
      bare.push(pid);
    }
  }
  return bare;
}

export function findBareChildren(parentPid: number): number[] {
  return process.platform === "win32"
    ? findBareChildrenWin32(parentPid)
    : findBareChildrenPosix(parentPid);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForBareChildren(
  parentPid: number,
  timeoutMs: number = BARE_DISCOVERY_TIMEOUT_MS,
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pids = findBareChildren(parentPid);
    if (pids.length > 0) return pids;
    await sleep(POLL_INTERVAL_MS);
  }
  return [];
}

