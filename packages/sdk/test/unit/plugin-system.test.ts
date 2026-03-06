// @ts-expect-error brittle has no type declarations
import test from "brittle";
import { z } from "zod";
import type FilesystemDL from "@qvac/dl-filesystem";
import { clearPlugins, registerPlugin } from "@/server/plugins";
import {
  registerModel,
  unregisterModel,
  type AnyModel,
} from "@/server/bare/registry/model-registry";
import {
  handlePluginInvoke,
  handlePluginInvokeStream,
} from "@/server/rpc/handlers/plugin-invoke";
import {
  ModelIsDelegatedError,
  PluginDefinitionInvalidError,
  PluginResponseValidationFailedError,
} from "@/utils/errors-server";
import { SDK_SERVER_ERROR_CODES, ModelType } from "@/schemas";

let idCounter = 0;
function makeId(prefix: string) {
  idCounter++;
  return `${prefix}-${idCounter}`;
}

test("registerPlugin: rejects invalid plugin definitions (fail-fast)", function (t) {
  clearPlugins();

  const invalidPlugin = {
    modelType: "test-plugin",
    displayName: "",
    addonPackage: "@qvac/test-addon",
    createModel: function () {
      return {
        model: { load: async function () {} },
        loader: {},
      };
    },
    handlers: {
      ping: {
        requestSchema: z.object({}),
        responseSchema: z.object({ ok: z.boolean() }),
        streaming: false,
        handler: async function () {
          return { ok: true };
        },
      },
    },
  };

  try {
    registerPlugin(invalidPlugin);
    t.fail("Expected registerPlugin to throw");
  } catch (error) {
    t.ok(error instanceof PluginDefinitionInvalidError);
    t.is((error as PluginDefinitionInvalidError).code, 53857);
  } finally {
    clearPlugins();
  }
});

test("pluginInvokeStream: validates streamed chunks against responseSchema", async function (t) {
  clearPlugins();

  const modelId = makeId("model");

  const requestSchema = z.object({ value: z.string() });
  const responseSchema = z.object({ token: z.string() });

  registerPlugin({
    modelType: ModelType.llamacppCompletion,
    displayName: "Test Plugin",
    addonPackage: "@qvac/test-addon",
    createModel: function () {
      return {
        model: { load: async function () {} },
        loader: {},
      };
    },
    handlers: {
      testStream: {
        requestSchema: requestSchema as z.ZodType,
        responseSchema: responseSchema as z.ZodType,
        streaming: true,
        handler: async function* () {
          yield { token: 123 };
        },
      },
    },
  });

  try {
    registerModel(modelId, {
      model: {} as unknown as AnyModel,
      path: "/tmp/model.bin",
      config: {},
      modelType: ModelType.llamacppCompletion,
      loader: {} as unknown as FilesystemDL,
    });

    const stream = handlePluginInvokeStream({
      type: "pluginInvokeStream",
      modelId,
      handler: "testStream",
      params: { value: "hello" },
    });

    try {
      await stream.next();
      t.fail("Expected stream.next() to throw");
    } catch (error) {
      t.ok(error instanceof PluginResponseValidationFailedError);
      t.is(
        (error as PluginResponseValidationFailedError).code,
        SDK_SERVER_ERROR_CODES.PLUGIN_RESPONSE_VALIDATION_FAILED,
      );
    }
  } finally {
    unregisterModel(modelId);
    clearPlugins();
  }
});

test("pluginInvoke: delegated models throw ModelIsDelegatedError", async function (t) {
  const modelId = makeId("delegated-model");

  registerModel(modelId, {
    topic: "test-topic",
    providerPublicKey: "test-provider-public-key",
  });

  try {
    await handlePluginInvoke({
      type: "pluginInvoke",
      modelId,
      handler: "anything",
      params: {},
    });
    t.fail("Expected handlePluginInvoke to throw");
  } catch (error) {
    t.ok(error instanceof ModelIsDelegatedError);
    t.is(
      (error as ModelIsDelegatedError).code,
      SDK_SERVER_ERROR_CODES.MODEL_IS_DELEGATED,
    );
  } finally {
    unregisterModel(modelId);
  }
});
