// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  buildBergamotVocabSources,
  deriveBergamotRegistryVocabSources,
  deriveBergamotVocabSources,
  resolveBergamotVocab,
  type PivotModelConfig,
} from "@/server/bare/plugins/nmtcpp-translation/resolve-vocab";
import type {
  ModelSrcInput,
  NmtConfig,
  ResolveContext,
} from "@/schemas";
import { ModelLoadFailedError } from "@/utils/errors-server";

interface MockResolveCall {
  src: ModelSrcInput;
}

function makeCtx(overrides: Partial<ResolveContext> & { modelSrc: string }): {
  ctx: ResolveContext;
  calls: MockResolveCall[];
} {
  const calls: MockResolveCall[] = [];
  const ctx: ResolveContext = {
    modelType: "nmtcpp-translation",
    resolveModelPath: async (src: ModelSrcInput) => {
      calls.push({ src });
      // Echo back a plausible "downloaded" path to keep the resolver happy.
      const s = typeof src === "string" ? src : String(src);
      return `/tmp/cache/${s.replace(/[^a-zA-Z0-9.]/g, "_")}`;
    },
    ...overrides,
  };
  return { ctx, calls };
}

const bergamotConfig: NmtConfig = {
  engine: "Bergamot",
  mode: "src-to-dst",
  from: "fr",
  to: "en",
  beamsize: 1,
  lengthpenalty: 1,
  maxlength: 256,
  repetitionpenalty: 1,
  norepeatngramsize: 0,
  temperature: 0,
  topk: 0,
  topp: 0,
} as unknown as NmtConfig;

const FREN_REGISTRY =
  "registry://s3/qvac_models_compiled/bergamot/bergamot-fren/2025-12-18/model.fren.intgemm.alphas.bin";
const ENFR_REGISTRY =
  "registry://s3/qvac_models_compiled/bergamot/bergamot-enfr/2025-12-18/model.enfr.intgemm.alphas.bin";
const FREN_PEAR =
  "pear://abc123def456/model.fren.intgemm.alphas.bin";

// ---------------------------------------------------------------------------
// Pure derivation helpers
// ---------------------------------------------------------------------------

test("buildBergamotVocabSources: shared vocab for non-CJK pair", (t: {
  is: Function;
}) => {
  const result = buildBergamotVocabSources("registry://s3/foo/", "fren");
  t.is(result.srcVocabSrc, "registry://s3/foo/vocab.fren.spm");
  t.is(result.dstVocabSrc, "registry://s3/foo/vocab.fren.spm");
});

test("buildBergamotVocabSources: split src/trg vocab for CJK pair", (t: {
  is: Function;
}) => {
  const result = buildBergamotVocabSources("registry://s3/foo/", "enja");
  t.is(result.srcVocabSrc, "registry://s3/foo/srcvocab.enja.spm");
  t.is(result.dstVocabSrc, "registry://s3/foo/trgvocab.enja.spm");
});

test("deriveBergamotVocabSources: parses pear:// model URL", (t: {
  is: Function;
}) => {
  const result = deriveBergamotVocabSources(FREN_PEAR);
  t.is(result?.srcVocabSrc, "pear://abc123def456/vocab.fren.spm");
  t.is(result?.dstVocabSrc, "pear://abc123def456/vocab.fren.spm");
});

test("deriveBergamotVocabSources: returns null for non-Bergamot URL", (t: {
  is: Function;
}) => {
  t.is(deriveBergamotVocabSources("pear://abc/some-other-model.bin"), null);
  t.is(deriveBergamotVocabSources("https://example.com/x"), null);
});

test("deriveBergamotRegistryVocabSources: parses registry:// model URL", (t: {
  is: Function;
}) => {
  const result = deriveBergamotRegistryVocabSources(FREN_REGISTRY);
  t.is(
    result?.srcVocabSrc,
    "registry://s3/qvac_models_compiled/bergamot/bergamot-fren/2025-12-18/vocab.fren.spm",
  );
  t.is(result?.dstVocabSrc, result?.srcVocabSrc);
});

// ---------------------------------------------------------------------------
// resolveBergamotVocab — registry:// optimization (QVAC-18420)
// ---------------------------------------------------------------------------
//
// The optimization: when the primary model is a registry:// source AND the
// caller did not override srcVocabSrc/dstVocabSrc, we skip per-vocab
// resolveModelPath calls because the companion-set download already places
// the vocabs next to the primary model and createModel derives those paths
// via deriveColocatedBergamotVocabPaths.

test("resolveBergamotVocab: registry:// + auto-derived vocabs → no resolveModelPath calls (non-pivot)", async (t: {
  is: Function;
  ok: Function;
  absent: Function;
}) => {
  const { ctx, calls } = makeCtx({ modelSrc: FREN_REGISTRY });

  const result = await resolveBergamotVocab(
    bergamotConfig,
    ctx,
    undefined,
    undefined,
    undefined,
  );

  t.is(calls.length, 0, "ctx.resolveModelPath was never called");
  t.absent(
    result.artifacts,
    "no artifacts emitted — createModel will derive colocated vocab paths",
  );
  t.is(result.config, bergamotConfig);
});

test("resolveBergamotVocab: registry:// + user-supplied srcVocabSrc → falls through to per-vocab resolution", async (t: {
  is: Function;
  ok: Function;
}) => {
  const { ctx, calls } = makeCtx({ modelSrc: FREN_REGISTRY });
  const userSrc = "registry://s3/custom/vocab.custom.spm";

  const result = await resolveBergamotVocab(
    bergamotConfig,
    ctx,
    userSrc,
    undefined,
    undefined,
  );

  t.is(
    calls.length,
    2,
    "resolves both vocabs when the user overrides one (sanity: optimization stays narrow)",
  );
  t.is(calls[0]!.src, userSrc, "honors user-supplied srcVocabSrc");
  t.ok(result.artifacts, "artifacts populated when full resolution runs");
});

test("resolveBergamotVocab: registry:// + user-supplied dstVocabSrc → falls through to per-vocab resolution", async (t: {
  is: Function;
}) => {
  const { ctx, calls } = makeCtx({ modelSrc: FREN_REGISTRY });
  const userDst = "registry://s3/custom/vocab.custom.spm";

  await resolveBergamotVocab(
    bergamotConfig,
    ctx,
    undefined,
    userDst,
    undefined,
  );

  t.is(calls.length, 2, "any user-supplied vocab disables the optimization");
});

test("resolveBergamotVocab: pear:// source still resolves vocabs explicitly (optimization is registry-only)", async (t: {
  is: Function;
}) => {
  const { ctx, calls } = makeCtx({ modelSrc: FREN_PEAR });

  await resolveBergamotVocab(
    bergamotConfig,
    ctx,
    undefined,
    undefined,
    undefined,
  );

  t.is(
    calls.length,
    2,
    "pear:// goes through full resolution; companion-set semantics don't apply",
  );
});

test("resolveBergamotVocab: throws when vocab cannot be derived (no overrides, unsupported source)", async (t: {
  ok: Function;
}) => {
  const { ctx } = makeCtx({ modelSrc: "https://example.com/model.bin" });

  await t.exception(
    async () =>
      resolveBergamotVocab(bergamotConfig, ctx, undefined, undefined, undefined),
    ModelLoadFailedError,
    "unsupported source with no override raises ModelLoadFailedError",
  );
});

// ---------------------------------------------------------------------------
// resolveBergamotVocab — pivot branch
// ---------------------------------------------------------------------------

test("resolveBergamotVocab: registry:// primary + registry:// pivot, all derived → only pivot model resolved", async (t: {
  is: Function;
  ok: Function;
}) => {
  const { ctx, calls } = makeCtx({ modelSrc: FREN_REGISTRY });
  const pivotModel: PivotModelConfig = { modelSrc: ENFR_REGISTRY };

  const result = await resolveBergamotVocab(
    bergamotConfig,
    ctx,
    undefined,
    undefined,
    pivotModel,
  );

  t.is(calls.length, 1, "exactly one resolve — the pivot model itself");
  t.is(calls[0]!.src, ENFR_REGISTRY);
  t.ok(result.artifacts);
  t.ok(
    result.artifacts && "pivotModelPath" in result.artifacts,
    "artifacts.pivotModelPath set",
  );
  t.is(
    result.artifacts && "srcVocabPath" in result.artifacts,
    false,
    "no srcVocabPath — createModel derives vocabs from colocated companion files",
  );
});

test("resolveBergamotVocab: pivot with user-supplied pivot vocab → all five resolves run", async (t: {
  is: Function;
}) => {
  const { ctx, calls } = makeCtx({ modelSrc: FREN_REGISTRY });
  const pivotModel: PivotModelConfig = {
    modelSrc: ENFR_REGISTRY,
    srcVocabSrc: "registry://s3/custom/pivot-vocab.spm",
  };

  await resolveBergamotVocab(
    bergamotConfig,
    ctx,
    undefined,
    undefined,
    pivotModel,
  );

  t.is(
    calls.length,
    5,
    "any user-supplied pivot vocab disables the pivot optimization (5 = src + dst + pivotSrc + pivotDst + pivotModel)",
  );
});

test("resolveBergamotVocab: pivot with pear:// pivot model → optimization skipped (pear:// has no companion set)", async (t: {
  is: Function;
}) => {
  const { ctx, calls } = makeCtx({ modelSrc: FREN_REGISTRY });
  const pivotModel: PivotModelConfig = { modelSrc: FREN_PEAR };

  await resolveBergamotVocab(
    bergamotConfig,
    ctx,
    undefined,
    undefined,
    pivotModel,
  );

  t.is(
    calls.length,
    5,
    "mixed registry/pear pivot triggers full resolution path",
  );
});

test("resolveBergamotVocab: pivot throws when pivot vocab cannot be derived", async (t: {
  ok: Function;
}) => {
  const { ctx } = makeCtx({ modelSrc: FREN_REGISTRY });
  const pivotModel: PivotModelConfig = {
    modelSrc: "https://example.com/pivot.bin",
  };

  await t.exception(
    async () =>
      resolveBergamotVocab(bergamotConfig, ctx, undefined, undefined, pivotModel),
    ModelLoadFailedError,
    "unsupported pivot source raises ModelLoadFailedError",
  );
});
