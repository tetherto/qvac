// @ts-expect-error brittle has no type declarations
import test from "brittle";
import { z } from "zod";
import { plugins } from "@/client/plugins-factory";
import { clearPlugins, getAllPlugins, hasPlugin } from "@/server/plugins";
import { ModelType } from "@/schemas";
import { PluginDefinitionInvalidError } from "@/utils/errors-server";
import type { QvacPlugin } from "@/schemas/plugin";

function makeValidPlugin(modelType: string): QvacPlugin {
  return {
    modelType,
    displayName: `Test ${modelType}`,
    addonPackage: `@qvac/test-${modelType}`,
    loadConfigSchema: z.object({}),
    createModel() {
      return { model: { load: async function () {} } };
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
}

test("plugins([]) returns host API namespace without registering anything", function (t) {
  clearPlugins();
  try {
    const sdk = plugins([]);
    t.is(getAllPlugins().length, 0, "no plugins registered");
    t.is(typeof sdk.translate, "function", "host API exposes translate");
    t.is(typeof sdk.completion, "function", "host API exposes completion");
    t.is(typeof sdk.loadModel, "function", "host API exposes loadModel");
  } finally {
    clearPlugins();
  }
});

test("plugins([one]) registers the plugin and returns host API", function (t) {
  clearPlugins();
  try {
    const p = makeValidPlugin(ModelType.nmtcppTranslation);
    const sdk = plugins([p]);
    t.ok(hasPlugin(ModelType.nmtcppTranslation), "plugin registered");
    t.is(getAllPlugins().length, 1);
    t.is(typeof sdk.translate, "function");
  } finally {
    clearPlugins();
  }
});

test("plugins([many]) registers all provided plugins", function (t) {
  clearPlugins();
  try {
    plugins([
      makeValidPlugin(ModelType.nmtcppTranslation),
      makeValidPlugin(ModelType.llamacppCompletion),
      makeValidPlugin(ModelType.llamacppEmbedding),
    ]);
    t.is(getAllPlugins().length, 3, "all three registered");
    t.ok(hasPlugin(ModelType.nmtcppTranslation));
    t.ok(hasPlugin(ModelType.llamacppCompletion));
    t.ok(hasPlugin(ModelType.llamacppEmbedding));
  } finally {
    clearPlugins();
  }
});

test("plugins([invalid]) throws validation error (fail-fast)", function (t) {
  clearPlugins();
  try {
    const invalid = {
      modelType: "broken",
      displayName: "",
      addonPackage: "@qvac/test-broken",
      createModel() {
        return { model: { load: async function () {} } };
      },
      handlers: {},
    } as unknown as QvacPlugin;

    try {
      plugins([invalid]);
      t.fail("Expected plugins() to throw");
    } catch (err) {
      t.ok(err instanceof PluginDefinitionInvalidError, "throws PluginDefinitionInvalidError");
    }
  } finally {
    clearPlugins();
  }
});
