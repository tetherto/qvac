/**
 * Child process spawned by NoLingeringBareExecutor.
 *
 * Calls modelRegistryList() to initialize the registry client (the source of
 * the 0.8.3 lingering-process regression), then waits for the harness to
 * trigger one of three shutdown modes:
 *
 *   sigterm        — harness sends SIGTERM; SDK handler cleans up
 *   close          — harness writes "CLOSE\n" to stdin; we call close()
 *                    then let the event loop drain (no process.exit)
 *   ipc-disconnect — harness sends SIGKILL; bare worker detects broken IPC
 */

import { modelRegistryList, close } from "@qvac/sdk";

type Mode = "sigterm" | "close" | "ipc-disconnect";

const VALID_MODES: Mode[] = ["sigterm", "close", "ipc-disconnect"];
const REGISTRY_INIT_TIMEOUT_MS = 30_000;

const mode = process.argv[2] as Mode | undefined;
if (!mode || !VALID_MODES.includes(mode)) {
  process.stderr.write(
    `Usage: no-lingering-bare-consumer.js <${VALID_MODES.join("|")}>\n`,
  );
  process.exit(1);
}

function log(message: string) {
  process.stderr.write(`[consumer] ${message}\n`);
}

async function triggerRegistryClient(): Promise<void> {
  // Force the bare worker to open the registry client (corestore + hyperswarm).
  // Timeout prevents blocking on offline CI.
  try {
    await Promise.race([
      modelRegistryList(),
      new Promise<never>((_, reject) => {
        const t: unknown = setTimeout(
          () => reject(new Error("modelRegistryList timeout")),
          REGISTRY_INIT_TIMEOUT_MS,
        );
        // Don't let the timeout keep the process alive (Bare returns object, not number)
        if (t && typeof t === "object" && "unref" in t) (t as { unref: () => void }).unref();
      }),
    ]);
    log("modelRegistryList resolved");
  } catch (error) {
    log(
      `modelRegistryList settled with error (expected offline): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function main(): Promise<void> {
  log(`starting (pid=${process.pid}, mode=${mode})`);

  await triggerRegistryClient();

  if (mode === "close") {
    let closeTriggered = false;
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      if (closeTriggered || chunk.trim() !== "CLOSE") return;
      closeTriggered = true;
      log("received CLOSE, calling close()");
      close()
        .then(() => {
          log("close() returned, letting event loop drain");
          process.stdin.destroy();
        })
        .catch((err: unknown) => {
          log(`close() failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(2);
        });
    });
  }

  process.stdout.write(`READY ${process.pid}\n`);
  log("READY, waiting for harness signal");

  // Keep the event loop alive until the harness triggers shutdown.
  process.stdin.resume();
}

main().catch(async (error) => {
  log(
    `fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
  );
  try {
    await close();
  } catch {
    // best-effort
  }
  process.exit(2);
});
