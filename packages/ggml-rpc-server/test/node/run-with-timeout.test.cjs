"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawn } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");
const { runWithRetry } = require("../../scripts/run-with-timeout.cjs");

const TIMEOUT_MS = 500;

// Stands in for bare-runtime's launcher: it spawns a long-lived child as the
// "native" process and ignores termination signals, so killing the launcher
// alone would leave that child running.
const LAUNCHER = `
const { existsSync, readFileSync, writeFileSync, appendFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const [countFile, pidFile, mode] = process.argv.slice(1);
const n = (existsSync(countFile) ? Number(readFileSync(countFile, "utf8")) : 0) + 1;
writeFileSync(countFile, String(n));
if (mode === "ok" || (mode === "hang-once" && n > 1)) process.exit(0);
if (mode === "fail") process.exit(3);
const native = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
appendFileSync(pidFile, native.pid + "\\n");
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => {});
`;

// A surviving child keeps the test runner's inherited stdout open, which hangs
// `node --test`, so cleanup kills every recorded child before removing them.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "qvac-run-with-timeout-"));
  const files = { count: join(dir, "count"), pids: join(dir, "pids") };
  t.after(() => {
    for (const pid of nativePids(files)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return files;
}

function run(files, mode, warnings = []) {
  return runWithRetry(
    process.execPath,
    ["-e", LAUNCHER, files.count, files.pids, mode],
    {
      attempts: 2,
      timeoutMs: TIMEOUT_MS,
      log: (line) => warnings.push(line),
    },
  );
}

function invocations(files) {
  return Number(readFileSync(files.count, "utf8"));
}

function nativePids(files) {
  if (!existsSync(files.pids)) return [];
  return readFileSync(files.pids, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(Number);
}

async function exited(pid) {
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return true;
      throw error;
    }
    await sleep(100);
  }
  return false;
}

test("a zero exit runs once", async (t) => {
  const files = fixture(t);
  await run(files, "ok");
  assert.equal(invocations(files), 1);
});

test("a non-zero exit fails without a retry", async (t) => {
  const files = fixture(t);
  await assert.rejects(run(files, "fail"), /failed \(3\)/);
  assert.equal(invocations(files), 1);
});

test("a stall is killed with the process it spawned, retried, then fails", async (t) => {
  const files = fixture(t);
  const warnings = [];
  await assert.rejects(
    run(files, "hang", warnings),
    /timed out after 0\.5s in each of 2 attempts/,
  );
  assert.equal(invocations(files), 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^::warning::.*attempt 1 timed out/);
  const pids = nativePids(files);
  assert.equal(pids.length, 2);
  for (const pid of pids) {
    assert.ok(await exited(pid), `spawned process ${pid} outlived the timeout`);
  }
});

test("a stall followed by a pass succeeds on the retry", async (t) => {
  const files = fixture(t);
  await run(files, "hang-once");
  assert.equal(invocations(files), 2);
  const [pid] = nativePids(files);
  assert.ok(await exited(pid), `spawned process ${pid} outlived the timeout`);
});

test("the fixture launcher really orphans its child when killed alone", async (t) => {
  // Guards the test above: if the launcher's child died with it anyway, the
  // stall test would pass even with a timeout that kills only the launcher.
  const files = fixture(t);
  const launcher = spawn(
    process.execPath,
    ["-e", LAUNCHER, files.count, files.pids, "hang"],
    { stdio: "inherit" },
  );
  while (nativePids(files).length === 0) await sleep(50);
  const [pid] = nativePids(files);
  launcher.kill("SIGKILL");
  await new Promise((resolve) => launcher.once("exit", resolve));
  await sleep(1000);
  assert.doesNotThrow(
    () => process.kill(pid, 0),
    "child should survive its launcher",
  );
});
