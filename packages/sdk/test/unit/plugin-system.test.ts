// @ts-expect-error brittle has no type declarations
import test from "brittle";
import { z } from "zod";
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
  PluginAlreadyRegisteredError,
  PluginDefinitionInvalidError,
  PluginModelTypeReservedError,
  PluginResponseValidationFailedError,
} from "@/utils/errors-server";
import { SDK_SERVER_ERROR_CODES, ModelType } from "@/schemas";
import { getPlugin, hasPlugin } from "@/server/plugins";

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
    loadConfigSchema: z.object({}),
    createModel: function () {
      return {
        model: { load: async function () {} },
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

test("registerPlugin: accepts valid plugin and retrieves it", function (t) {
  clearPlugins();

  const validPlugin = {
    modelType: "test-valid-plugin",
    displayName: "Valid Test Plugin",
    addonPackage: "@qvac/test-addon",
    loadConfigSchema: z.object({}),
    createModel: function () {
      return {
        model: { load: async function () {} },
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
    registerPlugin(validPlugin);

    t.ok(hasPlugin("test-valid-plugin"), "hasPlugin returns true");

    const retrieved = getPlugin("test-valid-plugin");
    t.ok(retrieved, "getPlugin returns the plugin");
    t.is(retrieved?.modelType, "test-valid-plugin");
    t.is(retrieved?.displayName, "Valid Test Plugin");
  } finally {
    clearPlugins();
  }
});

test("registerPlugin: rejects duplicate modelType registration", function (t) {
  clearPlugins();

  const plugin = {
    modelType: "test-duplicate-plugin",
    displayName: "First Plugin",
    addonPackage: "@qvac/test-addon",
    loadConfigSchema: z.object({}),
    createModel: function () {
      return {
        model: { load: async function () {} },
      };
    },
    handlers: {},
  };

  try {
    registerPlugin(plugin);
    t.ok(hasPlugin("test-duplicate-plugin"), "first registration succeeds");

    const duplicatePlugin = {
      ...plugin,
      displayName: "Duplicate Plugin",
    };

    try {
      registerPlugin(duplicatePlugin);
      t.fail("Expected registerPlugin to throw on duplicate");
    } catch (error) {
      t.ok(error instanceof PluginAlreadyRegisteredError);
      t.is(
        (error as PluginAlreadyRegisteredError).code,
        SDK_SERVER_ERROR_CODES.PLUGIN_ALREADY_REGISTERED,
      );
    }

    const retrieved = getPlugin("test-duplicate-plugin");
    t.is(
      retrieved?.displayName,
      "First Plugin",
      "original plugin is unchanged",
    );
  } finally {
    clearPlugins();
  }
});

test("registerPlugin: rejects alias as modelType", function (t) {
  clearPlugins();

  const plugin = {
    modelType: "llm",
    displayName: "Custom LLM Plugin",
    addonPackage: "@custom/llm",
    loadConfigSchema: z.object({}),
    createModel: function () {
      return {
        model: { load: async function () {} },
      };
    },
    handlers: {},
  };

  try {
    registerPlugin(plugin);
    t.fail("Expected registerPlugin to throw for alias modelType");
  } catch (error) {
    t.ok(error instanceof PluginModelTypeReservedError);
    t.is(
      (error as PluginModelTypeReservedError).code,
      SDK_SERVER_ERROR_CODES.PLUGIN_MODEL_TYPE_RESERVED,
    );
  } finally {
    clearPlugins();
  }
});
