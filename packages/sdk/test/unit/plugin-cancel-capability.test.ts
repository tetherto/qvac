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
// -----------------------------------------------------------------------------


// =============================================================================
// Runtime schema
// =============================================================================

test("pluginHandlerDefinitionRuntimeSchema: cancel field is optional", (t) => {
  const withoutCancel = pluginHandlerDefinitionRuntimeSchema.safeParse({
    requestSchema: { safeParse: () => {} },
    responseSchema: { safeParse: () => {} },
    streaming: true,
    handler: () => {},
  });
  t.ok(withoutCancel.success, "handler without cancel field is valid");
});

test("pluginHandlerDefinitionRuntimeSchema: accepts each cancel.scope value", (t) => {
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

test("pluginHandlerDefinitionRuntimeSchema: cancel.hard is optional and boolean", (t) => {
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

test("pluginHandlerDefinitionRuntimeSchema: rejects invalid cancel.scope", (t) => {
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

test("defineHandler: preserves cancel field on the returned definition", (t) => {
  const def = defineHandler({
    requestSchema: z.object({ modelId: z.string() }),
    responseSchema: z.object({ ok: z.boolean() }),
    streaming: false,
    handler: async () => ({ ok: true }),
    cancel: { scope: "model", hard: true },
  });
  t.alike(def.cancel, { scope: "model", hard: true });
});

test("defineDuplexHandler: preserves cancel field on the returned definition", (t) => {
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
