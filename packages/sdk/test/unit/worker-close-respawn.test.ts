// @ts-ignore brittle has no type declarations
import test from "brittle";

// After close() the old worker's exit event may fire asynchronously,
// while a new ensureRPC() has already started and assigned a fresh
// socket path to module state. If the exit handler reads module state
// it will unlink the *new* socket — the next worker then fails to
// connect with ENOENT. Each cycle here exercises that race.
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
