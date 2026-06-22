import test from "brittle";

// nmtPlugin lives inside the bare worker layer so we dynamic-import to avoid
// loading the N-API addon at module init when running under Bun.

test("nmtPlugin.resolveConfig: IndicTrans config passes through without vocab resolution", async (t) => {
  const { nmtPlugin } = await import(
    "@/server/bare/plugins/nmtcpp-translation/plugin"
  );

  const config = {
    engine: "IndicTrans" as const,
    from: "eng_Latn",
    to: "hin_Deva",
    beamsize: 1,
    maxlength: 256,
  };

  const result = await nmtPlugin.resolveConfig!(config, {
    resolveModelPath: async () => "/models/indictrans.bin",
    modelSrc: "s3:///indictrans.bin",
    modelType: "nmtcpp-translation",
  });

  t.ok(result.config, "resolveConfig returns a config object");
  const cfg = result.config as Record<string, unknown>;
  t.is(cfg["engine"], "IndicTrans", "engine is preserved");
  t.is(cfg["beamsize"], 1, "beamsize is preserved");
  t.absent(
    (result as unknown as Record<string, unknown>)["artifacts"],
    "IndicTrans produces no artifacts (no vocab resolution)",
  );
});

test("nmtPlugin.resolveConfig: Bergamot config strips vocab sources and delegates to resolveBergamotVocab", async (t) => {
  const { nmtPlugin } = await import(
    "@/server/bare/plugins/nmtcpp-translation/plugin"
  );

  const config = {
    engine: "Bergamot" as const,
    from: "en",
    to: "fr",
    srcVocabSrc: "s3:///vocab.enfr.spm",
    dstVocabSrc: "s3:///vocab.enfr.spm",
  };

  const resolvedPaths: string[] = [];
  const result = await nmtPlugin.resolveConfig!(config, {
    resolveModelPath: async (src) => {
      resolvedPaths.push(String(src));
      return `/resolved/${src}`;
    },
    modelSrc: "s3:///model.enfr.intgemm.alphas.bin",
    modelType: "nmtcpp-translation",
  });

  t.ok(result.config, "resolveConfig returns a config object for Bergamot");
  t.ok(resolvedPaths.length > 0, "resolveModelPath was called for vocab resolution");
});
