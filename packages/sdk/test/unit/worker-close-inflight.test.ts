// @ts-ignore brittle has no type declarations
import test from "brittle";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Contract-violator path: in-flight call during close() must reject
// with WorkerShutdownError, not hang.
test("close() rejects in-flight RPC calls with WorkerShutdownError", async function (t) {
  t.timeout(15_000);

  process.env["QVAC_WORKER_PATH"] = path.resolve(
    __dirname,
    "fixtures/stalling-worker.mjs",
  );

  const { embed } = await import("@/client/api/embed");
  const { close } = await import("@/client/rpc/rpc-client");

  t.teardown(() => {
    delete process.env["QVAC_WORKER_PATH"];
  });

  const call = embed({ modelId: "irrelevant", text: "hi" });
  call.catch(() => {});

  // Let the handshake complete before close() runs.
  await new Promise((r) => setTimeout(r, 250));

  await close();

  let hangTimer: ReturnType<typeof setTimeout> | undefined;
  let raceError: Error | undefined;
  try {
    await Promise.race([
      call,
      new Promise<never>((_, reject) => {
        hangTimer = setTimeout(
          () => reject(new Error("HUNG: embed() did not settle after close()")),
          5_000,
        );
      }),
    ]);
    t.fail("embed() resolved unexpectedly — expected WorkerShutdownError");
  } catch (err) {
    raceError = err as Error;
  } finally {
    if (hangTimer) clearTimeout(hangTimer);
  }

  t.ok(raceError, "expected embed() to reject");
  t.not(
    raceError?.message,
    "HUNG: embed() did not settle after close()",
    "embed() hung past close()",
  );
  t.is(
    (raceError as { name?: string } | undefined)?.name,
    "WORKER_SHUTDOWN",
    `expected WORKER_SHUTDOWN, got name=${(raceError as { name?: string } | undefined)?.name}`,
  );
});
