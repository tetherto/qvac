import test from "brittle";
import { shouldUseStreamErrorTransport } from "@/server/rpc/transport-selector";
import type { HandlerEntry } from "@/server/rpc/handler-utils";

const noop = (() => {}) as HandlerEntry["handler"];

function raw(fields: Record<string, unknown>): Record<string, unknown> {
  return fields;
}

const streamEntry: HandlerEntry = { type: "stream", handler: noop };
const replyEntry: HandlerEntry = { type: "reply", handler: noop };
const duplexEntry: HandlerEntry = { type: "duplex", handler: noop };
const progressAlwaysEntry: HandlerEntry = {
  type: "reply",
  handler: noop,
  supportsProgress: true,
};
const progressFnEntry: HandlerEntry = {
  type: "reply",
  handler: noop,
  supportsProgress: (r) =>
    r.type === "rag" &&
    ["ingest", "saveEmbeddings"].includes(
      (r as Record<string, unknown>).operation as string,
    ),
};

// ========== Stream handlers ==========

test("stream handler uses stream transport", (t: { ok: Function }) => {
  t.ok(
    shouldUseStreamErrorTransport(
      streamEntry,
      raw({ type: "completionStream" }),
    ),
  );
});

// ========== Progress reply handlers (withProgress: true) ==========

test("reply handler with supportsProgress=true and withProgress uses stream transport", (t: {
  ok: Function;
}) => {
  t.ok(
    shouldUseStreamErrorTransport(
      progressAlwaysEntry,
      raw({ type: "loadModel", withProgress: true }),
    ),
  );
});

test("reply handler with supportsProgress function and matching operation uses stream transport", (t: {
  ok: Function;
}) => {
  t.ok(
    shouldUseStreamErrorTransport(
      progressFnEntry,
      raw({ type: "rag", operation: "ingest", withProgress: true }),
    ),
  );
});

// ========== Must NOT use stream transport ==========

test("reply handler without progress uses reply transport", (t: {
  ok: Function;
}) => {
  t.ok(
    !shouldUseStreamErrorTransport(replyEntry, raw({ type: "getModelInfo" })),
  );
});

test("reply handler with supportsProgress=true but no withProgress uses reply transport", (t: {
  ok: Function;
}) => {
  t.ok(
    !shouldUseStreamErrorTransport(
      progressAlwaysEntry,
      raw({ type: "loadModel" }),
    ),
  );
});

test("reply handler with supportsProgress function and non-matching operation uses reply transport", (t: {
  ok: Function;
}) => {
  t.ok(
    !shouldUseStreamErrorTransport(
      progressFnEntry,
      raw({ type: "rag", operation: "search", withProgress: true }),
    ),
  );
});

test("duplex handler uses reply transport", (t: { ok: Function }) => {
  t.ok(
    !shouldUseStreamErrorTransport(
      duplexEntry,
      raw({ type: "transcribeStream" }),
    ),
  );
});

test("undefined entry uses reply transport", (t: { ok: Function }) => {
  t.ok(!shouldUseStreamErrorTransport(undefined, raw({ type: "nonexistent" })));
});

test("undefined rawRequest uses reply transport", (t: { ok: Function }) => {
  t.ok(!shouldUseStreamErrorTransport(progressAlwaysEntry, undefined));
});
