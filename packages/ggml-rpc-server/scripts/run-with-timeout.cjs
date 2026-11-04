"use strict";

const { spawn, spawnSync } = require("node:child_process");

// `bare` is bare-runtime's Node launcher: it spawns the native binary as a
// child and ignores termination signals. Killing only the launcher leaves the
// native process running, so a timeout kills the whole process tree.
function killTree(pid) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

// Resolves true when the command exits 0 and false when it is killed for
// outliving timeoutMs; rejects on any other outcome.
function runOnce(command, args, { cwd, env, shell = false, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell,
      stdio: "inherit",
      // On POSIX the child leads its own process group, which killTree signals.
      detached: process.platform !== "win32",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    // A detached group no longer receives the terminal's signals.
    const forward = () => killTree(child.pid);
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
    function settle() {
      clearTimeout(timer);
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
    }
    child.once("error", (error) => {
      settle();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      settle();
      if (timedOut) {
        resolve(false);
      } else if (code === 0) {
        resolve(true);
      } else {
        reject(
          new Error(`${command} ${args.join(" ")} failed (${code ?? signal})`),
        );
      }
    });
  });
}

async function runWithRetry(
  command,
  args,
  { attempts, timeoutMs, log = console.error, ...options },
) {
  const limit = `${timeoutMs / 1000}s`;
  for (let attempt = 1; ; attempt++) {
    if (await runOnce(command, args, { ...options, timeoutMs })) return;
    if (attempt >= attempts) {
      throw new Error(
        `${command} timed out after ${limit} in each of ${attempts} attempts`,
      );
    }
    log(
      `::warning::${command} attempt ${attempt} timed out after ${limit}; retrying`,
    );
  }
}

module.exports = { runWithRetry };
