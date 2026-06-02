import test from "brittle";
import { waitForBareChildren, isAlive } from "./utils/bare-children";

// Planned close() must not surface as a worker crash to callers.
test("close() after a successful call does not surface as a crash", async function (t) {
  t.timeout(20_000);

  delete process.env["QVAC_WORKER_PATH"];

  const { heartbeat } = await import("@/client/api/heartbeat");
  const { close } = await import("@/client/rpc/rpc-client");

  await heartbeat();
  const pidsBefore = await waitForBareChildren(process.pid);
  t.ok(
    pidsBefore.length > 0,
    `expected at least one bare child after warm-up; got ${pidsBefore.length}`,
  );

  await close();

  const deadline = Date.now() + 5_000;
  let stillAlive: number[] = [];
  while (Date.now() < deadline) {
    stillAlive = pidsBefore.filter((pid) => isAlive(pid));
    if (stillAlive.length === 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  t.is(
    stillAlive.length,
    0,
    `bare child(ren) should have exited after close(); still alive: ${stillAlive.join(",")}`,
  );

  await close();
  t.pass("close() is idempotent");
});
