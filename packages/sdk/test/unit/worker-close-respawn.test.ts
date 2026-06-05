import test from "brittle";

// Exercises the close-vs-respawn race: a stale exit handler must not
// unlink the new worker's socket.
test("close() followed by a new SDK call spawns a fresh worker", async function (t) {
  t.timeout(60_000);

  delete process.env["QVAC_WORKER_PATH"];

  const { heartbeat } = await import("@/client/api/heartbeat");
  const { close } = await import("@/client/rpc/rpc-client");

  t.teardown(async () => {
    try {
      await close();
    } catch {}
  });

  for (let i = 0; i < 5; i++) {
    const before = await heartbeat();
    t.ok(before, `cycle ${i}: warm-up heartbeat succeeded`);
    await close();
    const after = await heartbeat();
    t.ok(after, `cycle ${i}: heartbeat after close() spawned a fresh worker`);
  }
});
