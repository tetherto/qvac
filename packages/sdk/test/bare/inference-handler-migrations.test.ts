import test from "brittle";

// -----------------------------------------------------------------------------
// Inference-handler migration tests — Bare runtime.
//
// Covers the registry-driven cancel surface for the four registry-routed
// inference kinds (`embeddings`, `transcribe`, `translate`, `finetune`).
// The bare ops register themselves on the singleton registry via
// `getRequestRegistry().begin(...)`, so the assertions here exercise the
// same singleton — `cancel({ requestId })` and `cancel({ modelId, kind })`
// must both route to the ops' `signal.aborted`.
//
// These tests require the Bare runtime (bare-crypto, N-API addon bindings)
// and run via `npm run test:bare`.
//
// Schema-level tests (requestId acceptance) live in
// test/unit/inference-handler-migrations.test.ts.
// -----------------------------------------------------------------------------


let idCounter = 0;
function makeId(prefix: string): string {
  idCounter++;
  return `${prefix}-${idCounter}-${Date.now()}`;
}

test(
  "embed: cancel-by-requestId routes through registry and rejects with InferenceCancelledError",
  async (t) => {
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
        InferenceCancelledError as unknown as new () => Error,
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

test(
  "embed: cancel-by-modelId+kind aborts the in-flight embed",
  async (t) => {
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

      await t.exception(() => embedPromise, InferenceCancelledError as unknown as new () => Error);
    } finally {
      unregisterModel(modelId);
    }
  },
);

test(
  "embed: in-flight request is registered with kind='embeddings'",
  async (t) => {
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

test(
  "translate (NMT): cancel-by-modelId+kind aborts the batch path",
  async (t) => {
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
    let releaseRunBatch: () => void = () => {};
    let runBatchEntered: () => void = () => {};
    const runBatchEnteredPromise = new Promise<void>((resolve) => {
      runBatchEntered = resolve;
    });
    const runBatchGate = new Promise<void>((resolve) => {
      releaseRunBatch = resolve;
    });
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
        runBatchEntered();
        await runBatchGate;
        return text.map((s) => `t:${s}`);
      },
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
      await runBatchEnteredPromise;

      const cancelled = getRequestRegistry().cancel({
        modelId,
        kind: "translate",
      });
      t.is(cancelled, 1, "registry cancelled the translate-kind entry");
      releaseRunBatch();
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

test(
  "translate: in-flight request is registered with kind='translate'",
  async (t) => {
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

test(
  "transcribe (whisper): cancel-by-requestId exits loop and runs restorePrompt exactly once",
  async (t) => {
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
    let reloadCalls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const response = {
      async *iterate() {
        await gate;
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

test(
  "finetune: cancel-by-requestId calls model.cancel() and runs clearFinetuneRuntimeState",
  async (t) => {
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
        releaseAwait({ op: "finetune", status: "COMPLETED" });
      },
    };

    registerModel(modelId, {
      model: model as never,
      path: "/tmp/llama.gguf",
      config: {} as never,
      modelType: ModelType.llamacppCompletion,
    } as never);

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

      const runningState = getFinetuneState({
        modelId,
        options,
      } as never);
      t.is(runningState.status, "RUNNING", "runtime state flagged RUNNING");

      const cancelled = getRequestRegistry().cancel({ requestId });
      t.is(cancelled, 1, "registry cancelled the finetune entry");

      await finetunePromise;

      t.is(modelCancelCalls, 1, "registry abort forwarded to model.cancel()");

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
