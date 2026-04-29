import test from "brittle";
import { z } from "zod";
import { clearPlugins, registerPlugin } from "@/server/plugins";
import {
  registerModel,
  unregisterModel,
  type AnyModel,
} from "@/server/bare/registry/model-registry";
import { dispatchPluginReply } from "@/server/rpc/handlers/plugin-dispatch";
import { ModelOperationNotSupportedError } from "@/utils/errors-server";
import { SDK_SERVER_ERROR_CODES } from "@/schemas";

let idCounter = 0;
function makeId(prefix: string) {
  idCounter++;
  return `${prefix}-${idCounter}`;
}

test("ModelOperationNotSupportedError: empty supported and suggested degrade gracefully", function (t) {
  const error = new ModelOperationNotSupportedError(
    "modelid",
    "test-type",
    "transcribe",
    [],
    [],
  );

  t.ok(
    error.message.includes("does not expose any operations"),
    "empty supported uses the alternate clause",
  );
  t.ok(
    error.message.includes("No model registered in this worker bundle"),
    "empty suggestions uses the alternate clause",
  );
});

test("dispatch: throws ModelOperationNotSupportedError with bundle-aware suggestions, not loaded-model-aware", async function (t) {
  clearPlugins();

  const llmType = "test-llm-for-not-supported";
  const whisperType = "test-whisper-for-not-supported";

  registerPlugin({
    modelType: llmType,
    displayName: "Test LLM",
    addonPackage: "@qvac/test-addon",
    loadConfigSchema: z.object({}),
    createModel: function () {
      return { model: { load: async function () {} } };
    },
    handlers: {
      completionStream: {
        requestSchema: z.object({}),
        responseSchema: z.object({}),
        streaming: true,
        handler: async function* () {},
      },
    },
  });

  registerPlugin({
    modelType: whisperType,
    displayName: "Test Whisper",
    addonPackage: "@qvac/test-addon",
    loadConfigSchema: z.object({}),
    createModel: function () {
      return { model: { load: async function () {} } };
    },
    handlers: {
      transcribe: {
        requestSchema: z.object({}),
        responseSchema: z.object({}),
        streaming: true,
        handler: async function* () {},
      },
    },
  });

  const modelId = makeId("loaded-llm");
  registerModel(modelId, {
    model: {} as unknown as AnyModel,
    path: "/tmp/model.bin",
    config: {},
    modelType: llmType,
  });

  try {
    await dispatchPluginReply(modelId, "transcribe", {});
    t.fail("Expected dispatchPluginReply to throw");
  } catch (error) {
    t.ok(error instanceof ModelOperationNotSupportedError);
    const e = error as ModelOperationNotSupportedError;

    t.is(e.code, SDK_SERVER_ERROR_CODES.MODEL_OPERATION_NOT_SUPPORTED);
    t.is(e.operation, "transcribe");
    t.is(e.modelType, llmType);
    t.alike(e.supportedOperations, ["completionStream"]);
    t.alike(
      e.suggestedModelTypes,
      [whisperType],
      "suggestion comes from registered plugin even though no whisper model is loaded",
    );
  } finally {
    unregisterModel(modelId);
    clearPlugins();
  }
});
