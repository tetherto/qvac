// @ts-ignore brittle has no type declarations
import test from "brittle";
import { waitForBareChildren } from "./utils/bare-children";

// Post-crash recovery: next call must respawn, not reuse a dead RPC.
test("RPC client recovers from worker crash and serves the next call", async function (t) {
  t.timeout(30_000);

  delete process.env["QVAC_WORKER_PATH"];

  const { heartbeat } = await import("@/client/api/heartbeat");
  const { close } = await import("@/client/rpc/rpc-client");

  t.teardown(async () => {
    try {
      await close();
    } catch {}
  });

  await heartbeat();
  const firstPids = await waitForBareChildren(process.pid);
  t.ok(firstPids.length > 0, "first warm-up spawned a worker");

  for (const pid of firstPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }

  let crashError: Error | undefined;
  try {
    await heartbeat();
  } catch (err) {
    crashError = err as Error;
  }
  t.is(
    (crashError as { name?: string } | undefined)?.name,
    "WORKER_CRASHED",
    `expected first post-kill call to fail with WORKER_CRASHED, got name=${(crashError as { name?: string } | undefined)?.name}`,
  );

  const result = await heartbeat();
  t.ok(result, "second post-kill call succeeded on a fresh worker");

  const newPids = await waitForBareChildren(process.pid);
  t.ok(newPids.length > 0, "fresh worker is alive");
  const overlap = newPids.filter((p) => firstPids.includes(p));
  t.is(
    overlap.length,
    0,
    `new worker PIDs should not overlap with the killed ones; overlap=${overlap.join(",")}`,
  );
});
