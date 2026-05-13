// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  parakeetRuntimeConfigSchema,
  parakeetConfigSchema,
} from "@/schemas/transcription-config";

test("parakeetRuntimeConfigSchema: accepts empty config", (t) => {
  const result = parakeetRuntimeConfigSchema.parse({});
  t.alike(result, {});
});

test("parakeetRuntimeConfigSchema: accepts streaming + GPU options", (t) => {
  const result = parakeetRuntimeConfigSchema.parse({
    useGPU: true,
    streaming: true,
    streamingChunkMs: 1000,
    streamingHistoryMs: 30000,
    streamingEmitPartials: false,
    maxThreads: 4,
    seed: 42,
  });
  t.is(result.useGPU, true);
  t.is(result.streaming, true);
  t.is(result.streamingChunkMs, 1000);
  t.is(result.streamingHistoryMs, 30000);
  t.is(result.streamingEmitPartials, false);
  t.is(result.maxThreads, 4);
  t.is(result.seed, 42);
});

test("parakeetConfigSchema: accepts an empty config (modelSrc supplied at top level)", (t) => {
  // Parakeet 0.4+ takes only a single GGUF, and it is supplied via
  // `loadModel({ modelSrc })` rather than a per-engine field on
  // `modelConfig`. Empty `{}` must therefore round-trip cleanly.
  const result = parakeetConfigSchema.parse({});
  t.alike(result, {});
});

test("parakeetConfigSchema: rejects unknown fields under .strict()", (t) => {
  const result = parakeetConfigSchema
    .strict()
    .safeParse({ parakeetModelSrc: "pear://x/y.gguf" });
  t.ok(
    !result.success,
    "legacy `parakeetModelSrc` is rejected — use top-level modelSrc",
  );
});
