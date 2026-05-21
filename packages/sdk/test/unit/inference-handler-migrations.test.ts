// @ts-ignore brittle has no type declarations
import test from "brittle";
import {
  transcribeRequestSchema,
  transcribeStreamRequestSchema,
  translateRequestSchema,
} from "@/schemas";

// -----------------------------------------------------------------------------
// Inference-handler migration tests.
//
// Covers the registry-driven cancel surface for the four registry-routed
// inference kinds (`embeddings`, `transcribe`, `translate`, `finetune`).
// The bare ops register themselves on the singleton registry via
// `getRequestRegistry().begin(...)`, so the assertions here exercise the
// same singleton — `cancel({ requestId })` and `cancel({ modelId, kind })`
// must both route to the ops' `signal.aborted`.
//
// ---- Runtime gating ----
//
// The bare ops pull `bare-crypto` (via `request-id.ts` for the server-
// generated fallback UUID) and the embed/translate ops transitively pull
// other bare-* modules through the schemas/model registry. Bun can't load
// those N-API bindings, so this test file is `bareTest()`-gated like
// `plugin-cancel-capability.test.ts`. The schema-level test surface
// (request schemas accepting an optional `requestId`) is covered by the
// `*-schemas.test.ts` files; the registry-level surface is covered by
// `runtime/request-registry.test.ts`. The cancel-capability truth-table
// row for `finetune` (`{ scope: "model", hard: true }`) is verified in
// `plugin-cancel-capability.test.ts`.
// -----------------------------------------------------------------------------

const isBunUnitTestRunner =
  typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
// @ts-ignore Bare global only exists in Bare runtime
const isBareRuntime =
  !isBunUnitTestRunner && typeof globalThis.Bare !== "undefined";

type T = {
  is: (actual: unknown, expected: unknown, msg?: string) => void;
  ok: (value: unknown, msg?: string) => void;
  exception: (
    fn: () => Promise<unknown> | unknown,
    matcher?: unknown,
    msg?: string,
  ) => Promise<void>;
  alike: (actual: unknown, expected: unknown, msg?: string) => void;
};

function bareTest(name: string, fn: (t: T) => Promise<void> | void) {
  if (isBareRuntime) {
    test(name, fn);
  } else {
    test.skip(`[bare-only] ${name}`, () => {});
  }
}

let idCounter = 0;
function makeId(prefix: string): string {
  idCounter++;
  return `${prefix}-${idCounter}-${Date.now()}`;
}

// -- Schema-level requestId coverage for the registry-routed kinds -------
// embed/finetune `*-schemas.test.ts` files cover those two separately.
// Transcribe and translate don't have dedicated schema test files, so the
// new optional-`requestId` fields are exercised inline below.

test("transcribeRequestSchema: accepts an optional requestId", (t: T) => {
  const result = transcribeRequestSchema.safeParse({
    type: "transcribe",
    modelId: "m1",
    audioChunk: { type: "base64", value: "" },
    requestId: "req-1",
  });
  t.is(result.success, true);
});

test("transcribeRequestSchema: requestId is optional", (t: T) => {
  const result = transcribeRequestSchema.safeParse({
    type: "transcribe",
    modelId: "m1",
    audioChunk: { type: "base64", value: "" },
  });
  t.is(result.success, true);
});

test("transcribeStreamRequestSchema: accepts an optional requestId", (t: T) => {
  const result = transcribeStreamRequestSchema.safeParse({
    type: "transcribeStream",
    modelId: "m1",
    requestId: "req-stream",
  });
  t.is(result.success, true);
});

test("translateRequestSchema (NMT): accepts an optional requestId", (t: T) => {
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

test("translateRequestSchema (LLM): accepts an optional requestId", (t: T) => {
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

test("translateRequestSchema: rejects empty-string requestId", (t: T) => {
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

bareTest(
  "embed: cancel-by-requestId routes through registry and rejects with InferenceCancelledError",
  async (t: T) => {
    const [
      { registerModel, unregisterModel },
      { ModelType },
      { getRequestRegistry },
      { embed },
      { InferenceCancelledError },
    ] = await Promise.all([
      import("@/server/bare/registry/model-registry"),
      import("@/schemas"),
      import("@/server/bare/runtime/request-registry-singleton"),
      import("@/server/bare/ops/embed"),
      import("@/utils/errors-server"),
    ]);

    let addonCancelCalls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const modelId = makeId("embed-cancel-id");
    const requestId = makeId("req");

    const response = {
      async await() {
        await gate;
        return [[new Float32Array([1, 0, 0])]];
      },
      stats: { total_time_ms: 1, tokens_per_second: 1, total_tokens: 1 },
    };
    const model = {
      async run() {
        return response;
      },
      addon: {
        async cancel() {
          addonCancelCalls++;
        },
      },
    };

    registerModel(modelId, {
      model: model as unknown as Parameters<typeof registerModel>[1] extends {
        model: infer M;
      }
        ? M
        : never,
      path: "/tmp/embed.gguf",
      config: {},
      modelType: ModelType.llamacppEmbedding,
    } as Parameters<typeof registerModel>[1]);

    try {
      const embedPromise = embed({ modelId, text: "hello" }, requestId);
      await Promise.resolve();
      await Promise.resolve();

      const cancelled = getRequestRegistry().cancel({ requestId });
      t.is(cancelled, 1, "registry cancelled exactly one entry");

      release();

      await t.exception(
        () => embedPromise,
        InferenceCancelledError,
        "embed op rejects with InferenceCancelledError after cancel",
      );
      t.ok(
        addonCancelCalls >= 1,
        "registry abort forwarded to addon.cancel (hard-cancel)",
      );
    } finally {
      unregisterModel(modelId);
    }
  },
);

bareTest(
  "embed: cancel-by-modelId+kind aborts the in-flight embed",
  async (t: T) => {
    const [
      { registerModel, unregisterModel },
      { ModelType },
      { getRequestRegistry },
      { embed },
      { InferenceCancelledError },
    ] = await Promise.all([
      import("@/server/bare/registry/model-registry"),
      import("@/schemas"),
      import("@/server/bare/runtime/request-registry-singleton"),
      import("@/server/bare/ops/embed"),
      import("@/utils/errors-server"),
    ]);

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const modelId = makeId("embed-cancel-model");
    const requestId = makeId("req");
    const response = {
      async await() {
        await gate;
        return [[new Float32Array([1, 0, 0])]];
      },
      stats: { total_time_ms: 1, tokens_per_second: 1, total_tokens: 1 },
    };
    const model = {
      async run() {
        return response;
      },
      addon: {
        async cancel() {},
      },
    };

    registerModel(modelId, {
      model: model as never,
      path: "/tmp/embed.gguf",
      config: {},
      modelType: ModelType.llamacppEmbedding,
    } as never);

    try {
      const embedPromise = embed({ modelId, text: "hello" }, requestId);
      await Promise.resolve();
      await Promise.resolve();

      const cancelled = getRequestRegistry().cancel({
        modelId,
        kind: "embeddings",
      });
      t.is(cancelled, 1, "registry cancelled the matching kind");

      release();

      await t.exception(() => embedPromise, InferenceCancelledError);
    } finally {
      unregisterModel(modelId);
    }
  },
);

bareTest(
  "embed: in-flight request is registered with kind='embeddings'",
  async (t: T) => {
    const [
      { registerModel, unregisterModel },
      { ModelType },
      { getRequestRegistry },
      { embed },
    ] = await Promise.all([
      import("@/server/bare/registry/model-registry"),
      import("@/schemas"),
      import("@/server/bare/runtime/request-registry-singleton"),
      import("@/server/bare/ops/embed"),
    ]);

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const modelId = makeId("embed-listed");
    const requestId = makeId("req");

    const response = {
      async await() {
        await gate;
        return [[new Float32Array([1, 0, 0])]];
      },
      stats: { total_time_ms: 1, tokens_per_second: 1, total_tokens: 1 },
    };
    const model = {
      async run() {
        return response;
      },
      addon: {
        async cancel() {},
      },
    };

    registerModel(modelId, {
      model: model as never,
      path: "/tmp/embed.gguf",
      config: {},
      modelType: ModelType.llamacppEmbedding,
    } as never);

    try {
      const embedPromise = embed({ modelId, text: "x" }, requestId);
      await Promise.resolve();
      await Promise.resolve();

      const ctx = getRequestRegistry().get(requestId);
      t.ok(ctx !== null, "embed op registered the request");
      t.is(ctx?.kind, "embeddings");
      t.is(ctx?.modelId, modelId);

      release();
      await embedPromise;
    } finally {
      unregisterModel(modelId);
    }
  },
);

bareTest(
  "translate (NMT): cancel-by-modelId+kind aborts the batch path",
  async (t: T) => {
    const [
      { registerModel, unregisterModel },
      { ModelType },
      { getRequestRegistry },
      { translate },
    ] = await Promise.all([
      import("@/server/bare/registry/model-registry"),
      import("@/schemas"),
      import("@/server/bare/runtime/request-registry-singleton"),
      import("@/server/bare/ops/translate"),
    ]);

    const modelId = makeId("nmt-cancel-modelid");
    const requestId = makeId("req");
    let addonCancelCalls = 0;
    const response = {
      async *iterate() {
        yield "hello";
      },
      stats: { totalTime: 1, totalTokens: 1 },
    };
    const model = {
      async run() {
        return response;
      },
      async runBatch(text: string[]) {
        return text.map((s) => `t:${s}`);
      },
      // Even though `nmtcpp-translation.translate` declares
      // `cancel: { scope: "none" }`, instrument the addon so a future
      // regression that wires a hard-cancel listener for NMT trips
      // this assertion instead of silently breaking the contract.
      addon: {
        async cancel() {
          addonCancelCalls++;
        },
      },
    };

    registerModel(modelId, {
      model: model as never,
      path: "/tmp/nmt.bin",
      config: {},
      modelType: ModelType.nmtcppTranslation,
    } as never);

    try {
      const gen = translate(
        {
          modelId,
          text: ["one"],
          stream: true,
          modelType: ModelType.nmtcppTranslation,
        },
        requestId,
      );
      const stepPromise = gen.next();
      await Promise.resolve();
      await Promise.resolve();

      const cancelled = getRequestRegistry().cancel({
        modelId,
        kind: "translate",
      });
      t.is(cancelled, 1, "registry cancelled the translate-kind entry");
      const first = await stepPromise;
      t.is(first.done, true, "cancel ends the generator without yielding");
      t.is(
        addonCancelCalls,
        0,
        "soft-cancel contract: NMT must not invoke addon.cancel()",
      );
    } finally {
      unregisterModel(modelId);
    }
  },
);

bareTest(
  "translate: in-flight request is registered with kind='translate'",
  async (t: T) => {
    const [
      { registerModel, unregisterModel },
      { ModelType },
      { getRequestRegistry },
      { translate },
    ] = await Promise.all([
      import("@/server/bare/registry/model-registry"),
      import("@/schemas"),
      import("@/server/bare/runtime/request-registry-singleton"),
      import("@/server/bare/ops/translate"),
    ]);

    const modelId = makeId("translate-listed");
    const requestId = makeId("req");
    const response = {
      async *iterate() {
        yield "hello";
      },
      stats: { totalTime: 1 },
    };
    const model = {
      async run() {
        return response;
      },
      async runBatch(text: string[]) {
        return text.map((s) => `t:${s}`);
      },
    };

    registerModel(modelId, {
      model: model as never,
      path: "/tmp/nmt.bin",
      config: {},
      modelType: ModelType.nmtcppTranslation,
    } as never);

    try {
      const gen = translate(
        {
          modelId,
          text: ["foo"],
          stream: true,
          modelType: ModelType.nmtcppTranslation,
        },
        requestId,
      );
      const stepPromise = gen.next();
      await Promise.resolve();
      await Promise.resolve();

      const ctx = getRequestRegistry().get(requestId);
      t.ok(ctx !== null, "translate op registered the request");
      t.is(ctx?.kind, "translate");
      t.is(ctx?.modelId, modelId);

      getRequestRegistry().cancel({ requestId });
      await stepPromise;
    } finally {
      unregisterModel(modelId);
    }
  },
);

bareTest(
  "transcribe (whisper): cancel-by-requestId exits loop and runs restorePrompt exactly once",
  async (t: T) => {
    const [
      { registerModel, unregisterModel },
      { ModelType },
      { getRequestRegistry },
      { transcribe },
    ] = await Promise.all([
      import("@/server/bare/registry/model-registry"),
      import("@/schemas"),
      import("@/server/bare/runtime/request-registry-singleton"),
      import("@/server/bare/ops/transcribe"),
    ]);

    const modelId = makeId("transcribe-cancel-id");
    const requestId = makeId("req");
    let addonCancelCalls = 0;
    // `reload` is called by `applyPrompt` at handler entry (once) and
    // by `restorePrompt` at scope unwind (once). Count both — the test
    // pins the invariant: `restorePrompt` runs on every exit path
    // including cancel, via `scope.defer(...)`.
    let reloadCalls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const response = {
      async *iterate() {
        await gate;
        // Per-iteration `if (ctx.signal.aborted) break;` should fire
        // before this segment is yielded if cancel landed first.
        yield [{ text: "should not arrive" }];
      },
      stats: {},
    };
    const model = {
      async run() {
        return response;
      },
      async reload() {
        reloadCalls++;
      },
      addon: {
        async cancel() {
          addonCancelCalls++;
        },
      },
    };

    registerModel(modelId, {
      model: model as never,
      path: "/tmp/whisper.gguf",
      // `getModelConfig` returns this object; `applyPrompt`'s
      // destructure of `contextParams: _, miscConfig, ...whisperParams`
      // tolerates absent keys.
      config: { audio_format: "s16le" } as never,
      modelType: ModelType.whispercppTranscription,
    } as never);

    try {
      const gen = transcribe(
        {
          modelId,
          audioChunk: { type: "base64", value: "" },
          prompt: "p1",
        } as never,
        requestId,
      );
      const stepPromise = gen.next();
      // Yield once so `applyPrompt`'s `await model.reload(...)` and the
      // `await using ctx = ...` admission both run before we cancel.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const cancelled = getRequestRegistry().cancel({ requestId });
      t.is(cancelled, 1, "registry cancelled the transcribe entry");

      release();
      const first = await stepPromise;
      t.is(first.done, true, "cancel ends the generator without yielding");

      t.ok(
        addonCancelCalls >= 1,
        "registry abort forwarded to addon.cancel (hard-cancel)",
      );
      t.is(
        reloadCalls,
        2,
        "applyPrompt + restorePrompt each call reload exactly once",
      );
    } finally {
      unregisterModel(modelId);
    }
  },
);

bareTest(
  "finetune: cancel-by-requestId calls model.cancel() and runs clearFinetuneRuntimeState",
  async (t: T) => {
    const [
      { registerModel, unregisterModel },
      { ModelType },
      { getRequestRegistry },
      { startFinetune, getFinetuneState },
    ] = await Promise.all([
      import("@/server/bare/registry/model-registry"),
      import("@/schemas"),
      import("@/server/bare/runtime/request-registry-singleton"),
      import("@/server/bare/plugins/llamacpp-completion/ops/finetune"),
    ]);

    const modelId = makeId("finetune-cancel-id");
    const requestId = makeId("req");
    let modelCancelCalls = 0;
    let releaseAwait: (value: { op: "finetune"; status: "COMPLETED" }) => void =
      () => {};
    const awaitGate = new Promise<{ op: "finetune"; status: "COMPLETED" }>(
      (resolve) => {
        releaseAwait = resolve;
      },
    );

    const handle = {
      on() {
        return handle;
      },
      removeListener() {
        return handle;
      },
      async await() {
        return awaitGate;
      },
    };

    const model = {
      async finetune() {
        return handle;
      },
      async pause() {},
      async cancel() {
        modelCancelCalls++;
        // The real addon flips its cancel flag and the in-flight
        // finetune resolves with status. Mock that wire by releasing
        // the gate so `handle.await()` returns.
        releaseAwait({ op: "finetune", status: "COMPLETED" });
      },
    };

    registerModel(modelId, {
      model: model as never,
      path: "/tmp/llama.gguf",
      config: {} as never,
      modelType: ModelType.llamacppCompletion,
    } as never);

    // Use a checkpoint dir guaranteed not to exist so the post-cancel
    // `getFinetuneState(...)` falls through to `IDLE` rather than
    // hitting `bare-fs.readdirSync` on a real directory.
    const checkpointSaveDir = `/tmp/__qvac_nonexistent_${requestId}__`;
    const options = {
      trainDatasetDir: "/tmp/train",
      validation: { type: "none" as const },
      outputParametersDir: "/tmp/out",
      checkpointSaveDir,
    };

    try {
      const finetunePromise = startFinetune({
        type: "finetune",
        modelId,
        options,
        requestId,
      } as never);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Before cancel: runtime state is RUNNING (set by
      // `registerRunningFinetune`).
      const runningState = getFinetuneState({
        modelId,
        options,
      } as never);
      t.is(runningState.status, "RUNNING", "runtime state flagged RUNNING");

      const cancelled = getRequestRegistry().cancel({ requestId });
      t.is(cancelled, 1, "registry cancelled the finetune entry");

      await finetunePromise;

      t.is(modelCancelCalls, 1, "registry abort forwarded to model.cancel()");

      // After dispose: `clearFinetuneRuntimeState` ran via
      // `scope.defer(...)`, so runtime state is no longer RUNNING.
      // With a non-existent checkpoint dir the fallback is IDLE.
      const finalState = getFinetuneState({
        modelId,
        options,
      } as never);
      t.is(
        finalState.status,
        "IDLE",
        "scope unwind cleared the runtime-state flag",
      );
    } finally {
      unregisterModel(modelId);
    }
  },
);

test(
  "lifecycle logs: registry emits [request-lifecycle] lines on begin/cancel/end for the four registry-routed inference kinds",
  async (t: T) => {
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
      const ctx = r.begin({
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
