import test from "brittle";
import {
  pluginHandlerDefinitionRuntimeSchema,
  type PluginHandlerCancel,
} from "@/schemas/plugin";

// -----------------------------------------------------------------------------
// Built-in plugin cancel-capability truth table — Bare runtime tests.
//
// Locks the cancel-capability truth table in — if a future change flips
// a plugin's `cancel` declaration without the corresponding code path
// landing, this test fails loudly.
//
// These tests require the Bare runtime (addon bindings are N-API) and
// run via `npm run test:bare`.
//
// The schema-level and defineHandler tests (runtime-agnostic) live in
// test/unit/plugin-cancel-capability.test.ts.
// -----------------------------------------------------------------------------


test(
  "builtin plugins: every handler declares cancel matching the truth table",
  async (t) => {
    const [
      { llmPlugin },
      { embeddingsPlugin },
      { whisperPlugin },
      { parakeetPlugin },
      { nmtPlugin },
      { ttsPlugin },
      { ocrPlugin },
      { diffusionPlugin },
      { vlaPlugin },
      { classificationPlugin },
    ] = await Promise.all([
      import("@/server/bare/plugins/llamacpp-completion/plugin"),
      import("@/server/bare/plugins/llamacpp-embedding/plugin"),
      import("@/server/bare/plugins/whispercpp-transcription/plugin"),
      import("@/server/bare/plugins/parakeet-transcription/plugin"),
      import("@/server/bare/plugins/nmtcpp-translation/plugin"),
      import("@/server/bare/plugins/tts-ggml/plugin"),
      import("@/server/bare/plugins/ggml-ocr/plugin"),
      import("@/server/bare/plugins/sdcpp-generation/plugin"),
      import("@/server/bare/plugins/ggml-vla/plugin"),
      import("@/server/bare/plugins/ggml-classification/plugin"),
    ]);

    const truthTable: Record<string, Record<string, PluginHandlerCancel>> = {
      [llmPlugin.modelType]: {
        completionStream: { scope: "model", hard: true },
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
        textToSpeech: { scope: "model", hard: true },
        textToSpeechStream: { scope: "model", hard: true },
      },
      [ocrPlugin.modelType]: {
        ocrStream: { scope: "none" },
      },
      [diffusionPlugin.modelType]: {
        diffusionStream: { scope: "model", hard: true },
        videoStream: { scope: "model", hard: true },
        upscaleStream: { scope: "none" },
      },
      [vlaPlugin.modelType]: {
        vlaRun: { scope: "model", hard: true },
        vlaHparams: { scope: "none" },
      },
      [classificationPlugin.modelType]: {
        classify: { scope: "none" },
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
      vlaPlugin as unknown as BuiltinPlugin,
      classificationPlugin as unknown as BuiltinPlugin,
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
