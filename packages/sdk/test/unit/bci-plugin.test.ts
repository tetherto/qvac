import test from "brittle";
import { buildBciWhispercppArgs } from "@/server/bare/plugins/bci-whispercpp-transcription/args";
import { resolveBciConfig } from "@/server/bare/plugins/bci-whispercpp-transcription/resolve-config";
import type { ResolveContext } from "@/schemas";

const logger = {
  error: function () {},
  warn: function () {},
  info: function () {},
  debug: function () {},
};

test("buildBciWhispercppArgs forwards resolved embedder artifact", (t) => {
  const args = buildBciWhispercppArgs(
    "/models/ggml-bci-windowed.bin",
    "/models/bci-embedder.bin",
    logger,
  );

  t.alike(args.files, {
    model: "/models/ggml-bci-windowed.bin",
    embedder: "/models/bci-embedder.bin",
  });
  t.alike(args.opts, { stats: true });
});

test("buildBciWhispercppArgs omits embedder when artifact is absent", (t) => {
  const args = buildBciWhispercppArgs(
    "/models/ggml-bci-windowed.bin",
    "",
    logger,
  );

  t.alike(args.files, {
    model: "/models/ggml-bci-windowed.bin",
  });
});

test("resolveBciConfig resolves embedderModelSrc as embedderPath artifact", async (t) => {
  const resolved = await resolveBciConfig(
    {
      embedderModelSrc: "bci-embedder.bin",
      whisperConfig: { language: "en" },
    },
    makeResolveContext(),
  );

  t.alike(resolved.config, {
    whisperConfig: { language: "en" },
  });
  t.alike(resolved.artifacts, {
    embedderPath: "/resolved/bci-embedder.bin",
  });
});

test("resolveBciConfig preserves fallback config without embedder artifact", async (t) => {
  const resolved = await resolveBciConfig(
    {
      whisperConfig: { language: "en" },
    },
    makeResolveContext(),
  );

  t.alike(resolved.config, {
    whisperConfig: { language: "en" },
  });
  t.absent(resolved.artifacts);
});

function makeResolveContext() {
  const ctx: ResolveContext = {
    modelSrc: "ggml-bci-windowed.bin",
    modelType: "bci-whispercpp-transcription",
    resolveModelPath: async function (src) {
      return `/resolved/${typeof src === "string" ? src : src.modelId}`;
    },
  };
  return ctx;
}
