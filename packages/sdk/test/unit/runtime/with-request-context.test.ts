// @ts-expect-error brittle has no type declarations
import test from "brittle";
import type { LogLevel } from "@qvac/logging";
import type { Logger, LogTransport } from "@/logging/types";
import { withRequestContext } from "@/server/bare/runtime/with-request-context";

// -----------------------------------------------------------------------------
// withRequestContext — handler-side per-request logger wrapper.
//
// Covers the acceptance criteria for the `withRequestContext`
// helper:
//   - Every emit (debug/info/warn/error/trace) gets prefixed with
//     `[request-lifecycle <kind> requestId=<id> modelId=<id>]`.
//   - The prefix shape drops `modelId=...` when the request has no
//     `modelId`.
//   - `setLevel` / `getLevel` / `addTransport` / `setConsoleOutput`
//     pass straight through to the underlying logger — the wrapper
//     is a thin shim, not a separate logger instance.
//   - Multi-argument calls preserve every argument after the first
//     (the wrapper only prefixes the leading message).
// -----------------------------------------------------------------------------

type T = {
  is: (actual: unknown, expected: unknown, msg?: string) => void;
  alike: (actual: unknown, expected: unknown, msg?: string) => void;
  ok: (value: unknown, msg?: string) => void;
};

type EmitRecord = { level: LogLevel; args: unknown[] };

function makeStubLogger(): Logger & {
  emits: EmitRecord[];
  levelState: { value: LogLevel };
  transports: LogTransport[];
  console: { enabled: boolean };
} {
  const emits: EmitRecord[] = [];
  const transports: LogTransport[] = [];
  const levelState: { value: LogLevel } = { value: "info" };
  const console: { enabled: boolean } = { enabled: true };

  function record(level: LogLevel) {
    return (...args: unknown[]) => emits.push({ level, args });
  }

  return {
    emits,
    levelState,
    transports,
    console,
    error: record("error"),
    warn: record("warn"),
    info: record("info"),
    debug: record("debug"),
    trace: record("trace"),
    setLevel: (level: LogLevel) => {
      levelState.value = level;
    },
    getLevel: () => levelState.value,
    addTransport: (transport: LogTransport) => transports.push(transport),
    setConsoleOutput: (enabled: boolean) => {
      console.enabled = enabled;
    },
  };
}

test("withRequestContext: prefixes every level with kind/requestId/modelId", (t: T) => {
  const stub = makeStubLogger();
  const log = withRequestContext(stub, {
    requestId: "abc-123",
    kind: "completion",
    modelId: "llama-7b",
  });

  log.info("decoding token");
  log.warn("addon retry");
  log.error("decode failed");
  log.debug("kv-cache hit");
  log.trace("entered fn");

  const expectedPrefix =
    "[request-lifecycle completion requestId=abc-123 modelId=llama-7b] ";

  t.is(stub.emits.length, 5);
  t.alike(stub.emits[0], {
    level: "info",
    args: [expectedPrefix + "decoding token"],
  });
  t.alike(stub.emits[1], {
    level: "warn",
    args: [expectedPrefix + "addon retry"],
  });
  t.alike(stub.emits[2], {
    level: "error",
    args: [expectedPrefix + "decode failed"],
  });
  t.alike(stub.emits[3], {
    level: "debug",
    args: [expectedPrefix + "kv-cache hit"],
  });
  t.alike(stub.emits[4], {
    level: "trace",
    args: [expectedPrefix + "entered fn"],
  });
});

test("withRequestContext: drops modelId segment when the request has no modelId", (t: T) => {
  const stub = makeStubLogger();
  const log = withRequestContext(stub, {
    requestId: "req-1",
    kind: "embeddings",
  });

  log.info("hello");

  t.alike(stub.emits[0], {
    level: "info",
    args: ["[request-lifecycle embeddings requestId=req-1] hello"],
  });
});

test("withRequestContext: preserves extra arguments after the leading message", (t: T) => {
  const stub = makeStubLogger();
  const log = withRequestContext(stub, {
    requestId: "r-x",
    kind: "completion",
    modelId: "m1",
  });

  const extra = { tokens: 42 };
  log.info("decoded chunk", extra, 99);

  t.alike(stub.emits[0], {
    level: "info",
    args: [
      "[request-lifecycle completion requestId=r-x modelId=m1] decoded chunk",
      extra,
      99,
    ],
  });
});

test("withRequestContext: zero-argument emits still ship the prefix on its own", (t: T) => {
  const stub = makeStubLogger();
  const log = withRequestContext(stub, {
    requestId: "r-y",
    kind: "transcribe",
    modelId: "whisper-small",
  });

  log.info();

  t.alike(stub.emits[0], {
    level: "info",
    args: [
      "[request-lifecycle transcribe requestId=r-y modelId=whisper-small] ",
    ],
  });
});

test("withRequestContext: setLevel/getLevel/addTransport/setConsoleOutput pass through", (t: T) => {
  const stub = makeStubLogger();
  const log = withRequestContext(stub, {
    requestId: "r-z",
    kind: "completion",
    modelId: "m1",
  });

  log.setLevel("debug");
  t.is(stub.levelState.value, "debug", "setLevel writes through to underlying logger");
  t.is(log.getLevel(), "debug", "getLevel reads through to underlying logger");

  const transport: LogTransport = () => {};
  log.addTransport(transport);
  t.is(stub.transports.length, 1, "addTransport registers on the underlying logger");
  t.is(stub.transports[0], transport, "exact transport reference threaded through");

  log.setConsoleOutput(false);
  t.is(stub.console.enabled, false, "setConsoleOutput writes through");
});
