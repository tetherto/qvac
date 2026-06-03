import test from "brittle";
import { z } from "zod";
import { ensurePluginsRegistered } from "@/client/rpc/ensure-worker-ready";
import { clearPlugins, registerPlugin } from "@/server/plugins";
import {
  PearWorkerEntryRequiredError,
  WorkerPluginsNotRegisteredError,
} from "@/utils/errors-client";
import { ModelType } from "@/schemas";
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

test("ensurePluginsRegistered: throws WorkerPluginsNotRegisteredError on non-Pear with zero plugins", async function (t) {
  clearPlugins();
  try {
    await ensurePluginsRegistered({ isPear: false });
    t.fail("expected ensurePluginsRegistered to throw");
  } catch (err) {
    const ctor = (err as Error)?.constructor?.name ?? typeof err;
    t.ok(
      err instanceof WorkerPluginsNotRegisteredError,
      `expected WorkerPluginsNotRegisteredError, got ${ctor}`,
    );
  } finally {
    clearPlugins();
  }
});

test("ensurePluginsRegistered: throws PearWorkerEntryRequiredError on Pear with zero plugins", async function (t) {
  clearPlugins();
  try {
    await ensurePluginsRegistered({ isPear: true });
    t.fail("expected ensurePluginsRegistered to throw");
  } catch (err) {
    const ctor = (err as Error)?.constructor?.name ?? typeof err;
    t.ok(
      err instanceof PearWorkerEntryRequiredError,
      `expected PearWorkerEntryRequiredError, got ${ctor}`,
    );
  } finally {
    clearPlugins();
  }
});

test("ensurePluginsRegistered: noop when at least one plugin is registered (non-Pear)", async function (t) {
  clearPlugins();
  try {
    registerPlugin(makeValidPlugin(ModelType.nmtcppTranslation));
    await ensurePluginsRegistered({ isPear: false });
    t.pass("no throw with a registered plugin");
  } finally {
    clearPlugins();
  }
});

test("ensurePluginsRegistered: noop when at least one plugin is registered (Pear)", async function (t) {
  clearPlugins();
  try {
    registerPlugin(makeValidPlugin(ModelType.nmtcppTranslation));
    await ensurePluginsRegistered({ isPear: true });
    t.pass("no throw with a registered plugin even when isPear");
  } finally {
    clearPlugins();
  }
});
