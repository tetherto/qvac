import test from "brittle";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Doomed worker handshakes then exits 100ms later without ever replying.
// Without the worker-life signal the SDK call hangs forever.
test("embed() rejects when bare worker dies post-handshake (doomed worker)", async function (t) {
  t.timeout(15_000);

  // WORKER_PATH is resolved at module load — set before importing.
  process.env["QVAC_WORKER_PATH"] = path.resolve(
    __dirname,
    "fixtures/doomed-worker.mjs",
  );

  const { embed } = await import("@/client/api/embed");
  // Use rpc-client's close(): it routes through `#rpc` → dist, hitting
  // the same module instance the SDK uses. Importing node-rpc-client
  // directly would load a separate source copy with empty state.
  const { close } = await import("@/client/rpc/rpc-client");

  t.teardown(async () => {
    try {
      await close();
    } catch {}
    delete process.env["QVAC_WORKER_PATH"];
  });

  const call = embed({ modelId: "irrelevant", text: "hi" });

  let hangTimer: ReturnType<typeof setTimeout> | undefined;
  let raceError: Error | undefined;
  try {
    await Promise.race([
      call,
      new Promise<never>((_, reject) => {
        hangTimer = setTimeout(
          () =>
            reject(new Error("HUNG: embed() did not settle within 5s")),
          5_000,
        );
      }),
    ]);
    t.fail("embed() resolved unexpectedly — expected a worker-crash error");
  } catch (err) {
    raceError = err as Error;
  } finally {
    if (hangTimer) clearTimeout(hangTimer);
  }

  call.catch(() => {});

  t.ok(raceError, "expected embed() to reject");
  t.not(
    raceError?.message,
    "HUNG: embed() did not settle within 5s",
    "SDK call hung past the budget",
  );
  t.is(
    (raceError as { name?: string } | undefined)?.name,
    "WORKER_CRASHED",
    `expected WORKER_CRASHED, got name=${(raceError as { name?: string } | undefined)?.name}`,
  );
});
