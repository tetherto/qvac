// @ts-expect-error brittle has no type declarations
import test from "brittle";
import { AbortController } from "bare-abort-controller";
import type { LogLevel } from "@qvac/logging";
import type { Logger, LogTransport } from "@/logging/types";
import { createRequestRegistry } from "@/server/bare/runtime/request-registry";

// -----------------------------------------------------------------------------
// Registry structured logging (Deliverable 3)
//
// Locks in the `[request-lifecycle] <event>` line shape the registry
// emits at `begin` / `cancel` / `end`. The lines are the only log
// surface downstream consumers can grep for "what happened on
// requestId=X" without instrumenting every handler — so the shape is
// part of the 0.11.0 request-lifecycle contract.
//
// Tests use the `options.logger` injection on `createRequestRegistry`
// to capture every `info(...)` call without touching the SDK's
// cached singleton logger.
// -----------------------------------------------------------------------------

type T = {
  is: (actual: unknown, expected: unknown, msg?: string) => void;
  alike: (actual: unknown, expected: unknown, msg?: string) => void;
  ok: (value: unknown, msg?: string) => void;
};

interface EmitRecord {
  level: LogLevel;
  args: unknown[];
}

function makeLoggerStub(): Logger & { emits: EmitRecord[] } {
  const emits: EmitRecord[] = [];
  const stub = (level: LogLevel) =>
    (...args: unknown[]) => {
      emits.push({ level, args });
    };
  return {
    emits,
    error: stub("error"),
    warn: stub("warn"),
    info: stub("info"),
    debug: stub("debug"),
    trace: stub("trace"),
    setLevel: () => {},
    getLevel: () => "info" as LogLevel,
    addTransport: (_: LogTransport) => {},
    setConsoleOutput: () => {},
  };
}

function infoLines(stub: { emits: EmitRecord[] }): string[] {
  return stub.emits
    .filter((e) => e.level === "info")
    .map((e) => String(e.args[0] ?? ""));
}

function warnLines(stub: { emits: EmitRecord[] }): string[] {
  return stub.emits
    .filter((e) => e.level === "warn")
    .map((e) => String(e.args[0] ?? ""));
}

// `end` lines carry a `durationMs=<n>` segment whose value is wall-clock
// dependent — strip it so assertions can compare the rest of the shape
// against a stable expected string.
const DURATION_SUFFIX_RE = / durationMs=\d+$/;
function stripDuration(line: string): string {
  return line.replace(DURATION_SUFFIX_RE, "");
}

test("registry: begin emits a [request-lifecycle] begin line", async (t: T) => {
  const log = makeLoggerStub();
  const r = createRequestRegistry({ logger: log });

  await using ctx = r.begin({
    requestId: "r-1",
    kind: "completion",
    modelId: "m1",
  });
  t.is(ctx.requestId, "r-1");

  const lines = infoLines(log);
  t.ok(
    lines.includes(
      "[request-lifecycle] begin requestId=r-1 kind=completion modelId=m1 state=running",
    ),
    "begin line carries kind, modelId, and state=running",
  );
});

test("registry: cancel-by-requestId emits a [request-lifecycle] cancel line once", async (t: T) => {
  const log = makeLoggerStub();
  const r = createRequestRegistry({ logger: log });

  await using ctx = r.begin({
    requestId: "r-1",
    kind: "completion",
    modelId: "m1",
  });
  r.cancel({ requestId: "r-1", reason: "stop-button" });
  // Second call must NOT log again — cancelEntry's guard suppresses
  // the no-op cancel so consumers never see two lines for one
  // logical cancel.
  r.cancel({ requestId: "r-1", reason: "stop-button" });
  t.is(ctx.state, "cancelling");

  const cancels = infoLines(log).filter((l) => l.startsWith("[request-lifecycle] cancel"));
  t.is(cancels.length, 1, "cancel line emitted exactly once");
  t.is(
    cancels[0],
    "[request-lifecycle] cancel requestId=r-1 kind=completion modelId=m1 state=cancelling",
  );
});

test("registry: end emits a [request-lifecycle] end line with the terminal state + durationMs", async (t: T) => {
  const log = makeLoggerStub();
  const r = createRequestRegistry({ logger: log });

  async function happyRun() {
    await using ctx = r.begin({
      requestId: "r-happy",
      kind: "completion",
      modelId: "m1",
    });
    return ctx.requestId;
  }
  await happyRun();

  const ends = infoLines(log).filter((l) => l.startsWith("[request-lifecycle] end"));
  t.ok(
    DURATION_SUFFIX_RE.test(ends[0]),
    "end line carries `durationMs=<n>` segment for log-driven latency analysis",
  );
  t.is(
    stripDuration(ends[0]),
    "[request-lifecycle] end requestId=r-happy kind=completion modelId=m1 state=completed",
    "happy end carries state=completed",
  );

  async function cancelledRun() {
    await using ctx = r.begin({
      requestId: "r-cancelled",
      kind: "completion",
      modelId: "m1",
    });
    r.cancel({ requestId: "r-cancelled" });
    return ctx.requestId;
  }
  await cancelledRun();

  const allEnds = infoLines(log).filter((l) => l.startsWith("[request-lifecycle] end"));
  t.ok(
    allEnds.map(stripDuration).includes(
      "[request-lifecycle] end requestId=r-cancelled kind=completion modelId=m1 state=cancelled",
    ),
    "cancelled end carries state=cancelled",
  );
});

test("registry: failed end emits at warn level, not info", async (t: T) => {
  // Ops alerting wants a cheap `level>=warn` predicate on the
  // [request-lifecycle] prefix; the failure path is the only one
  // that should lift level above info.
  const log = makeLoggerStub();
  const r = createRequestRegistry({ logger: log });

  async function failedRun() {
    await using ctx = r.begin({
      requestId: "r-failed",
      kind: "completion",
      modelId: "m1",
    });
    ctx.state = "failed";
  }
  await failedRun();

  const failedInfo = infoLines(log).filter(
    (l) => l.startsWith("[request-lifecycle] end") && l.includes("state=failed"),
  );
  t.is(failedInfo.length, 0, "failed end does not emit at info level");

  const failedWarn = warnLines(log).filter(
    (l) => l.startsWith("[request-lifecycle] end") && l.includes("state=failed"),
  );
  t.is(failedWarn.length, 1, "failed end emits exactly one warn line");
  t.is(
    stripDuration(failedWarn[0]),
    "[request-lifecycle] end requestId=r-failed kind=completion modelId=m1 state=failed",
  );
  t.ok(
    DURATION_SUFFIX_RE.test(failedWarn[0]),
    "warn-level failed end still carries durationMs= for parity",
  );
});

test("registry: cancelAll emits one cancel line per active request", async (t: T) => {
  const log = makeLoggerStub();
  const r = createRequestRegistry({ logger: log });

  await using a = r.begin({
    requestId: "r-a",
    kind: "completion",
    modelId: "m1",
  });
  await using b = r.begin({
    requestId: "r-b",
    kind: "embeddings",
    modelId: "m2",
  });
  t.is(a.kind, "completion");
  t.is(b.kind, "embeddings");

  await r.cancelAll("shutdown");

  const cancels = infoLines(log).filter((l) => l.startsWith("[request-lifecycle] cancel"));
  t.is(cancels.length, 2, "one cancel line per active entry");
  t.ok(
    cancels.includes(
      "[request-lifecycle] cancel requestId=r-a kind=completion modelId=m1 state=cancelling",
    ),
  );
  t.ok(
    cancels.includes(
      "[request-lifecycle] cancel requestId=r-b kind=embeddings modelId=m2 state=cancelling",
    ),
  );
});

test("registry: parentSignal already aborted lands begin with state=cancelling", async (t: T) => {
  const log = makeLoggerStub();
  const r = createRequestRegistry({ logger: log });

  const parent = new AbortController();
  parent.abort("shutdown");

  await using ctx = r.begin({
    requestId: "r-pre",
    kind: "completion",
    modelId: "m1",
    parentSignal: parent.signal,
  });
  t.is(ctx.state, "cancelling");

  const begins = infoLines(log).filter((l) => l.startsWith("[request-lifecycle] begin"));
  t.is(
    begins[0],
    "[request-lifecycle] begin requestId=r-pre kind=completion modelId=m1 state=cancelling",
    "begin line reflects pre-aborted parent",
  );
});

test("registry: begin without modelId emits state line with modelId=-", async (t: T) => {
  const log = makeLoggerStub();
  const r = createRequestRegistry({ logger: log });

  await using ctx = r.begin({
    requestId: "r-no-model",
    kind: "completion",
  });
  t.is(ctx.modelId, undefined);

  const begins = infoLines(log).filter((l) => l.startsWith("[request-lifecycle] begin"));
  t.is(
    begins[0],
    "[request-lifecycle] begin requestId=r-no-model kind=completion modelId=- state=running",
    "absent modelId surfaces as `-` placeholder so grep `modelId=` still hits",
  );
});
