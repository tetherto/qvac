import test from "brittle";
import {
  ensureDhtBootstrapped,
  describeConnectFailure,
} from "@/server/bare/delegate-connect-diagnostics";

function fakeDht(opts: {
  bootstrapped: boolean;
  resolve?: boolean;
  onCall?: () => void;
}) {
  return {
    bootstrapped: opts.bootstrapped,
    fullyBootstrapped() {
      opts.onCall?.();
      return opts.resolve === false
        ? new Promise<void>(() => {})
        : Promise.resolve();
    },
  };
}

test("ensureDhtBootstrapped: warm swarm returns without awaiting bootstrap", async (t) => {
  let called = false;
  const dht = fakeDht({ bootstrapped: true, onCall: () => (called = true) });

  await ensureDhtBootstrapped(dht, 5000);

  t.is(
    called,
    false,
    "fullyBootstrapped() is not called when already bootstrapped",
  );
});

test("ensureDhtBootstrapped: cold swarm awaits bootstrap once", async (t) => {
  let calls = 0;
  const dht = fakeDht({
    bootstrapped: false,
    resolve: true,
    onCall: () => calls++,
  });

  await ensureDhtBootstrapped(dht, 100);

  t.is(calls, 1, "fullyBootstrapped() is awaited when cold");
});

test("ensureDhtBootstrapped: cold swarm that never bootstraps falls through on timeout", async (t) => {
  const dht = fakeDht({ bootstrapped: false, resolve: false });

  const start = Date.now();
  await ensureDhtBootstrapped(dht, 50);
  const elapsed = Date.now() - start;

  t.ok(elapsed >= 40, "waited for the bounded cap");
  t.ok(elapsed < 1000, "did not hang indefinitely");
});

test("describeConnectFailure: PEER_NOT_FOUND explains discovery failure and relay role", (t) => {
  const msg = describeConnectFailure({ code: "PEER_NOT_FOUND" }, "abc123", 1);

  t.ok(
    msg.includes("not found on the DHT"),
    "explains the peer was not discovered",
  );
  t.ok(msg.includes("abc123"), "includes the target public key");
  t.ok(
    msg.includes("1 swarm relay(s) configured"),
    "reports the configured relay count",
  );
});

test("describeConnectFailure: no relays configured is reported", (t) => {
  const msg = describeConnectFailure({ code: "PEER_NOT_FOUND" }, "abc123", 0);

  t.ok(msg.includes("no swarm relays configured"), "reports zero relays");
});

test("describeConnectFailure: holepunch/NAT codes are categorized as found-but-unreachable", (t) => {
  const msg = describeConnectFailure({ code: "CANNOT_HOLEPUNCH" }, "abc123", 0);

  t.ok(msg.includes("found but a connection could not be established"));
  t.ok(msg.includes("CANNOT_HOLEPUNCH"), "names the underlying failure code");
});

test("describeConnectFailure: unknown errors fall back to the original message", (t) => {
  const msg = describeConnectFailure(new Error("boom"), "abc123", 0);

  t.is(msg, "boom");
});

test("describeConnectFailure: non-Error values are stringified", (t) => {
  const msg = describeConnectFailure("plain string failure", "abc123", 0);

  t.is(msg, "plain string failure");
});
