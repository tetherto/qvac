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

test("parakeetConfigSchema: accepts an explicit parakeetModelSrc", (t) => {
  const result = parakeetConfigSchema.parse({
    parakeetModelSrc: "pear://abc/parakeet-tdt-0.6b-v3.q8_0.gguf",
    useGPU: false,
  });
  t.is(result.parakeetModelSrc, "pear://abc/parakeet-tdt-0.6b-v3.q8_0.gguf");
  t.is(result.useGPU, false);
});

test("parakeetConfigSchema: accepts no parakeetModelSrc (falls back to modelSrc)", (t) => {
  const result = parakeetConfigSchema.parse({});
  t.is(result.parakeetModelSrc, undefined);
});
