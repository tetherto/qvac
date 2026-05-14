// @ts-ignore brittle has no type declarations
import test from "brittle";
import { z } from "zod";
import {
  defineHandler,
  defineDuplexHandler,
  pluginHandlerDefinitionRuntimeSchema,
  type PluginHandlerCancel,
} from "@/schemas/plugin";

// -----------------------------------------------------------------------------
// PluginHandlerDefinition.cancel — declarative cancel-capability tests.
//
// Pins the cancel-capability contract:
//   - Runtime schema accepts an absent `cancel`, every valid `scope`, and
//     rejects invalid scopes.
//   - `defineHandler` / `defineDuplexHandler` thread the field through
//     unmodified.
//   - Every built-in plugin manifest carries the truth-table value for
//     its addon's cancel surface — guards against silent regressions
//     where a future plugin manifest tweak forgets to keep `cancel` in
//     sync with the addon (e.g. adding a hard-cancel call to nmtcpp
//     without flipping its declaration off `"none"`).
//
// ---- Runtime gating ----
//
// Built-in plugin manifests load real `@qvac/*` addons (llamacpp,
// whispercpp, parakeet, …) which carry N-API bindings that Bun can't
// resolve. The truth-table block dynamically imports those manifests
// and so runs only under the Bare unit-test entry. The schema /
// `defineHandler` tests are runtime-agnostic and run under both.
// -----------------------------------------------------------------------------

const isBunUnitTestRunner =
  typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
// @ts-ignore Bare global only exists in Bare runtime
const isBareRuntime =
  !isBunUnitTestRunner && typeof globalThis.Bare !== "undefined";

function bareTest(name: string, fn: (t: BrittleT) => Promise<void> | void) {
  if (isBareRuntime) {
    test(name, fn);
  } else {
    test.skip(`[bare-only] ${name}`, () => {});
  }
}

type BrittleT = {
  is: (actual: unknown, expected: unknown, msg?: string) => void;
  ok: (value: unknown, msg?: string) => void;
  not: (actual: unknown, expected: unknown, msg?: string) => void;
  alike: (actual: unknown, expected: unknown, msg?: string) => void;
};

// =============================================================================
// Runtime schema
// =============================================================================

test("pluginHandlerDefinitionRuntimeSchema: cancel field is optional", (t: BrittleT) => {
  const withoutCancel = pluginHandlerDefinitionRuntimeSchema.safeParse({
    requestSchema: { safeParse: () => {} },
    responseSchema: { safeParse: () => {} },
    streaming: true,
    handler: () => {},
  });
  t.ok(withoutCancel.success, "handler without cancel field is valid");
});

test("pluginHandlerDefinitionRuntimeSchema: accepts each cancel.scope value", (t: BrittleT) => {
  const scopes: PluginHandlerCancel["scope"][] = ["request", "model", "none"];
  for (const scope of scopes) {
    const result = pluginHandlerDefinitionRuntimeSchema.safeParse({
      requestSchema: { safeParse: () => {} },
      responseSchema: { safeParse: () => {} },
      streaming: false,
      handler: () => {},
      cancel: { scope },
    });
    t.ok(result.success, `cancel.scope='${scope}' is valid`);
  }
});

test("pluginHandlerDefinitionRuntimeSchema: cancel.hard is optional and boolean", (t: BrittleT) => {
  const withHardTrue = pluginHandlerDefinitionRuntimeSchema.safeParse({
    requestSchema: { safeParse: () => {} },
    responseSchema: { safeParse: () => {} },
    streaming: false,
    handler: () => {},
    cancel: { scope: "model", hard: true },
  });
  t.ok(withHardTrue.success, "hard:true is valid");

  const withHardFalse = pluginHandlerDefinitionRuntimeSchema.safeParse({
    requestSchema: { safeParse: () => {} },
    responseSchema: { safeParse: () => {} },
    streaming: false,
    handler: () => {},
    cancel: { scope: "model", hard: false },
  });
  t.ok(withHardFalse.success, "hard:false is valid");

  const withoutHard = pluginHandlerDefinitionRuntimeSchema.safeParse({
    requestSchema: { safeParse: () => {} },
    responseSchema: { safeParse: () => {} },
    streaming: false,
    handler: () => {},
    cancel: { scope: "none" },
  });
  t.ok(withoutHard.success, "hard omitted is valid");
});

test("pluginHandlerDefinitionRuntimeSchema: rejects invalid cancel.scope", (t: BrittleT) => {
  const result = pluginHandlerDefinitionRuntimeSchema.safeParse({
    requestSchema: { safeParse: () => {} },
    responseSchema: { safeParse: () => {} },
    streaming: false,
    handler: () => {},
    cancel: { scope: "everywhere" },
  });
  t.is(result.success, false, "invalid scope is rejected");
});

// =============================================================================
// defineHandler / defineDuplexHandler — field threading
// =============================================================================

test("defineHandler: preserves cancel field on the returned definition", (t: BrittleT) => {
  const def = defineHandler({
    requestSchema: z.object({ modelId: z.string() }),
    responseSchema: z.object({ ok: z.boolean() }),
    streaming: false,
    handler: async () => ({ ok: true }),
    cancel: { scope: "model", hard: true },
  });
  t.alike(def.cancel, { scope: "model", hard: true });
});

test("defineDuplexHandler: preserves cancel field on the returned definition", (t: BrittleT) => {
  const def = defineDuplexHandler({
    requestSchema: z.object({ modelId: z.string() }),
    responseSchema: z.object({ ok: z.boolean() }),
    streaming: true,
    duplex: true,
    handler: async function* () {
      yield { ok: true };
    },
    cancel: { scope: "none" },
  });
  t.alike(def.cancel, { scope: "none" });
});

// =============================================================================
// Built-in plugin truth table (bare-only — addon bindings require Bare)
//
// Locks the cancel-capability truth table in — if a future change flips
// a plugin's `cancel` declaration without the corresponding code path
// landing, this test fails loudly.
// =============================================================================

bareTest(
  "builtin plugins: every handler declares cancel matching the truth table",
  async (t: BrittleT) => {
    const [
      { llmPlugin },
      { embeddingsPlugin },
      { whisperPlugin },
      { parakeetPlugin },
      { nmtPlugin },
      { ttsPlugin },
      { ocrPlugin },
      { diffusionPlugin },
    ] = await Promise.all([
      import("@/server/bare/plugins/llamacpp-completion/plugin"),
      import("@/server/bare/plugins/llamacpp-embedding/plugin"),
      import("@/server/bare/plugins/whispercpp-transcription/plugin"),
      import("@/server/bare/plugins/parakeet-transcription/plugin"),
      import("@/server/bare/plugins/nmtcpp-translation/plugin"),
      import("@/server/bare/plugins/onnx-tts/plugin"),
      import("@/server/bare/plugins/onnx-ocr/plugin"),
      import("@/server/bare/plugins/sdcpp-generation/plugin"),
    ]);

    const truthTable: Record<string, Record<string, PluginHandlerCancel>> = {
      [llmPlugin.modelType]: {
        completionStream: { scope: "model", hard: true },
        // `finetune` declares `{ scope: "model", hard: true }`: the
        // addon exposes `model.cancel()` for the running finetune job,
        // and `startFinetune` wires it through the registry's abort
        // signal.
        finetune: { scope: "model", hard: true },
        translate: { scope: "model", hard: true },
      },
      [embeddingsPlugin.modelType]: {
        embed: { scope: "model", hard: true },
      },
      [whisperPlugin.modelType]: {
        transcribe: { scope: "model", hard: true },
        transcribeStream: { scope: "model", hard: true },
      },
      [parakeetPlugin.modelType]: {
        transcribe: { scope: "model", hard: true },
        transcribeStream: { scope: "model", hard: true },
      },
      [nmtPlugin.modelType]: {
        translate: { scope: "none" },
      },
      [ttsPlugin.modelType]: {
        textToSpeech: { scope: "none" },
        textToSpeechStream: { scope: "none" },
      },
      [ocrPlugin.modelType]: {
        ocrStream: { scope: "none" },
      },
      [diffusionPlugin.modelType]: {
        diffusionStream: { scope: "model", hard: true },
        upscaleStream: { scope: "none" },
      },
    };

    type BuiltinPlugin = {
      modelType: string;
      handlers: Record<
        string,
        { cancel?: PluginHandlerCancel } & Record<string, unknown>
      >;
    };

    const builtins: BuiltinPlugin[] = [
      llmPlugin as unknown as BuiltinPlugin,
      embeddingsPlugin as unknown as BuiltinPlugin,
      whisperPlugin as unknown as BuiltinPlugin,
      parakeetPlugin as unknown as BuiltinPlugin,
      nmtPlugin as unknown as BuiltinPlugin,
      ttsPlugin as unknown as BuiltinPlugin,
      ocrPlugin as unknown as BuiltinPlugin,
      diffusionPlugin as unknown as BuiltinPlugin,
    ];

    for (const plugin of builtins) {
      const expectedHandlers = truthTable[plugin.modelType];
      t.ok(
        expectedHandlers !== undefined,
        `${plugin.modelType} has a row in the brief truth table`,
      );
      if (!expectedHandlers) continue;
      for (const [handlerName, expected] of Object.entries(expectedHandlers)) {
        const handler = plugin.handlers[handlerName];
        t.ok(
          handler !== undefined,
          `${plugin.modelType}.${handlerName} is registered`,
        );
        if (!handler) continue;
        t.alike(
          handler.cancel,
          expected,
          `${plugin.modelType}.${handlerName} declares the expected cancel surface`,
        );
        const result = pluginHandlerDefinitionRuntimeSchema.safeParse(handler);
        t.ok(
          result.success,
          `${plugin.modelType}.${handlerName} validates against the runtime schema`,
        );
      }
    }
  },
);
