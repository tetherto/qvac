import test from "brittle";
import { waitForBareChildren } from "./utils/bare-children";

// Real worker, warm up, SIGKILL the bare child, then issue a new call
// into the cached-but-dead rpcInstance. Without the worker-life signal
// the call hangs on the orphaned bare-rpc reply.
test("RPC call rejects when bare workers are killed mid-call", async function (t) {
  t.timeout(25_000);

  delete process.env["QVAC_WORKER_PATH"];

  const { heartbeat } = await import("@/client/api/heartbeat");
  // See worker-crash-doomed.test.ts for why we route through rpc-client.
  const { close } = await import("@/client/rpc/rpc-client");

  t.teardown(async () => {
    try {
      await close();
    } catch {}
  });

  // Warm-up: killing before handshake hits RPCInitTimeoutError instead.
  await heartbeat();

  const pids = await waitForBareChildren(process.pid);
  t.ok(
    pids.length > 0,
    `expected at least one bare child; found ${pids.length}`,
  );
  if (pids.length === 0) return;

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }

  // rpcInstance is still cached; send() reuses the now-dead socket.
  const promise = heartbeat();
  promise.catch(() => {});

  let hangTimer: ReturnType<typeof setTimeout> | undefined;
  let raceError: Error | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        hangTimer = setTimeout(
          () =>
            reject(new Error("HUNG: heartbeat() did not settle within 10s")),
          10_000,
        );
      }),
    ]);
    t.fail("heartbeat() resolved unexpectedly — expected a worker-crash error");
  } catch (err) {
    raceError = err as Error;
  } finally {
    if (hangTimer) clearTimeout(hangTimer);
  }

  t.ok(raceError, "expected heartbeat() to reject");
  t.not(
    raceError?.message,
    "HUNG: heartbeat() did not settle within 10s",
    "SDK call hung past the budget",
  );
  t.is(
    (raceError as { name?: string } | undefined)?.name,
    "WORKER_CRASHED",
    `expected WORKER_CRASHED, got name=${(raceError as { name?: string } | undefined)?.name}`,
  );
});
