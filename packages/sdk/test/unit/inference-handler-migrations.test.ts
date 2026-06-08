import test from "brittle";
import {
  transcribeRequestSchema,
  transcribeStreamRequestSchema,
  translateRequestSchema,
} from "@/schemas";

// -----------------------------------------------------------------------------
// Inference-handler migration tests — schema-level (Bun/Node).
//
// Covers the request schema `requestId` field acceptance and the
// registry lifecycle log shape. The op-level cancel tests (embed,
// translate, transcribe, finetune) that exercise the real bare ops
// live in test/bare/inference-handler-migrations.test.ts.
// -----------------------------------------------------------------------------


// -- Schema-level requestId coverage for the registry-routed kinds -------
// embed/finetune `*-schemas.test.ts` files cover those two separately.
// Transcribe and translate don't have dedicated schema test files, so the
// new optional-`requestId` fields are exercised inline below.

test("transcribeRequestSchema: accepts an optional requestId", (t) => {
  const result = transcribeRequestSchema.safeParse({
    type: "transcribe",
    modelId: "m1",
    audioChunk: { type: "base64", value: "" },
    requestId: "req-1",
  });
  t.is(result.success, true);
});

test("transcribeRequestSchema: requestId is optional", (t) => {
  const result = transcribeRequestSchema.safeParse({
    type: "transcribe",
    modelId: "m1",
    audioChunk: { type: "base64", value: "" },
  });
  t.is(result.success, true);
});

test("transcribeStreamRequestSchema: accepts an optional requestId", (t) => {
  const result = transcribeStreamRequestSchema.safeParse({
    type: "transcribeStream",
    modelId: "m1",
    requestId: "req-stream",
  });
  t.is(result.success, true);
});

test("translateRequestSchema (NMT): accepts an optional requestId", (t) => {
  const result = translateRequestSchema.safeParse({
    type: "translate",
    modelId: "m1",
    text: "hello",
    stream: true,
    modelType: "nmt",
    requestId: "req-nmt",
  });
  t.is(result.success, true);
});

test("translateRequestSchema (LLM): accepts an optional requestId", (t) => {
  const result = translateRequestSchema.safeParse({
    type: "translate",
    modelId: "m1",
    text: "hello",
    stream: true,
    modelType: "llm",
    from: "en",
    to: "fr",
    requestId: "req-llm",
  });
  t.is(result.success, true);
});

test("translateRequestSchema: rejects empty-string requestId", (t) => {
  const result = translateRequestSchema.safeParse({
    type: "translate",
    modelId: "m1",
    text: "hello",
    stream: true,
    modelType: "nmt",
    requestId: "",
  });
  t.is(result.success, false);
});

test(
  "lifecycle logs: registry emits [request-lifecycle] lines on begin/cancel/end for the four registry-routed inference kinds",
  async (t) => {
    // Confirms the registry's lifecycle log shape independently of which
    // op is driving it. The op-level wiring (`withRequestContext`) is
    // covered by `runtime/with-request-context.test.ts`; this assertion
    // proves the begin/cancel/end events carry the
    // `[request-lifecycle] <event> requestId=... kind=... modelId=...`
    // prefix that operators and log shippers depend on, exercised
    // explicitly for each of the registry-routed inference kinds.
    const { createRequestRegistry } = await import(
      "@/server/bare/runtime/request-registry"
    );

    const kinds = [
      "embeddings",
      "transcribe",
      "translate",
      "finetune",
    ] as const;
    for (const kind of kinds) {
      const lines: string[] = [];
      const stubLogger = {
        info: (msg: string) => lines.push(`info:${msg}`),
        warn: (msg: string) => lines.push(`warn:${msg}`),
        error: (msg: string) => lines.push(`error:${msg}`),
        debug: () => {},
      };
      const r = createRequestRegistry({
        // The createRequestRegistry options accept a Logger-shaped value;
        // brittle tests don't go through tsc so the structural shape is
        // sufficient.
        logger: stubLogger as never,
      } as never);

      const requestId = `lifecycle-${kind}`;
      const ctx = await r.begin({
        requestId,
        kind,
        modelId: `test-${kind}`,
      });
      r.cancel({ requestId });
      await r.end(requestId, "cancelled");
      t.is(ctx.state, "cancelled");

      const begin = lines.find((l) => l.includes("[request-lifecycle] begin"));
      const cancel = lines.find((l) =>
        l.includes("[request-lifecycle] cancel"),
      );
      const end = lines.find((l) => l.includes("[request-lifecycle] end"));

      t.ok(begin, `begin lifecycle line emitted for ${kind}`);
      t.ok(cancel, `cancel lifecycle line emitted for ${kind}`);
      t.ok(end, `end lifecycle line emitted for ${kind}`);
      t.ok(begin?.includes(`kind=${kind}`), `begin carries kind=${kind}`);
      t.ok(begin?.includes(`requestId=${requestId}`), `begin carries requestId`);
      t.ok(
        begin?.includes(`modelId=test-${kind}`),
        `begin carries modelId for ${kind}`,
      );
    }
  },
);
