// @ts-expect-error brittle has no type declarations
import test from "brittle";
import { deduplicateModels } from "@/models/update-models/registry";
import { groupCompanionSets } from "@/models/update-models/companions";
import type {
  CompanionSetMetadata,
  ProcessedModel,
} from "@/models/update-models/types";

function makeModel(
  overrides: Partial<ProcessedModel> & { registryPath: string },
): ProcessedModel {
  return {
    registrySource: "s3",
    modelId: overrides.registryPath.split("/").pop() || "",
    addon: "nmt",
    engine: "nmtcpp-translation",
    modelName: "bergamot",
    quantization: "",
    params: "",
    tags: [],
    expectedSize: 1000,
    sha256Checksum: "default-sha",
    blobCoreKey: "key",
    blobBlockOffset: 0,
    blobBlockLength: 1,
    blobByteOffset: 0,
    ...overrides,
  };
}

test("deduplicateModels: drops plain checksum duplicates", (t: {
  is: Function;
  ok: Function;
}) => {
  const a = makeModel({ registryPath: "pkg/a.gguf", sha256Checksum: "SHA1" });
  const b = makeModel({ registryPath: "pkg/b.gguf", sha256Checksum: "SHA1" });

  const result = deduplicateModels([a, b], false);

  t.is(result.length, 1, "drops the second duplicate");
  t.is(result[0]!.registryPath, "pkg/a.gguf", "keeps the first");
});

test("deduplicateModels: keeps empty-checksum entries as-is", (t: {
  is: Function;
}) => {
  const a = makeModel({ registryPath: "pkg/a.gguf", sha256Checksum: "" });
  const b = makeModel({ registryPath: "pkg/b.gguf", sha256Checksum: "" });

  const result = deduplicateModels([a, b], false);

  t.is(result.length, 2, "neither is dropped when checksum is empty");
});

// ---------------------------------------------------------------------------
// Regression: QVAC-18420 — Bergamot shared vocabs
// ---------------------------------------------------------------------------
//
// For pairs where both translation directions ship the same vocab blob under
// distinct registry paths (e.g. bergamot-fren/vocab.fren.spm and
// bergamot-enfr/vocab.enfr.spm share a sha256), dedup must not drop the entry
// that is referenced as a companion in some companion set — otherwise
// `getModelByPath()` can't resolve the companion path and the single-file
// fallback uses `expectedSize = 0`, causing the cached file to be unlinked and
// re-downloaded on every `loadModel` call.

test("deduplicateModels: preserves companion-referenced duplicates (QVAC-18420)", (t: {
  is: Function;
  ok: Function;
}) => {
  const sharedSha = "783abf3abe075afdf8d85d233994bef2c3a064e935ab1bed946820aff6ac002a";

  const modelEnFr = makeModel({
    registryPath: "bergamot/bergamot-enfr/2025/model.enfr.intgemm.alphas.bin",
    sha256Checksum: "enfr-model-sha",
  });
  const vocabEnFr = makeModel({
    registryPath: "bergamot/bergamot-enfr/2025/vocab.enfr.spm",
    sha256Checksum: sharedSha,
    expectedSize: 814404,
  });
  const modelFrEn = makeModel({
    registryPath: "bergamot/bergamot-fren/2025/model.fren.intgemm.alphas.bin",
    sha256Checksum: "fren-model-sha",
  });
  const vocabFrEn = makeModel({
    registryPath: "bergamot/bergamot-fren/2025/vocab.fren.spm",
    sha256Checksum: sharedSha,
    expectedSize: 814404,
  });

  const grouped = groupCompanionSets([modelEnFr, vocabEnFr, modelFrEn, vocabFrEn]);
  const result = deduplicateModels(grouped, false);

  const paths = result.map((m) => m.registryPath);
  t.ok(
    paths.includes("bergamot/bergamot-enfr/2025/vocab.enfr.spm"),
    "enfr vocab preserved",
  );
  t.ok(
    paths.includes("bergamot/bergamot-fren/2025/vocab.fren.spm"),
    "fren vocab preserved (would have been deduped before the fix)",
  );
});

test("deduplicateModels: still drops non-companion duplicates even when others are companions", (t: {
  is: Function;
  ok: Function;
  absent: Function;
}) => {
  const sharedSha = "shared-vocab-sha";

  const modelFrEn = makeModel({
    registryPath: "bergamot/bergamot-fren/2025/model.fren.intgemm.alphas.bin",
    sha256Checksum: "fren-model-sha",
  });
  const vocabFrEn = makeModel({
    registryPath: "bergamot/bergamot-fren/2025/vocab.fren.spm",
    sha256Checksum: sharedSha,
  });
  const grouped = groupCompanionSets([modelFrEn, vocabFrEn]);

  // A random, unrelated file that happens to share the vocab's sha256.
  // It is not referenced by any companion set, so dedup should still drop it.
  const randomDuplicate = makeModel({
    registryPath: "other/unrelated.bin",
    sha256Checksum: sharedSha,
  });

  const result = deduplicateModels([...grouped, randomDuplicate], false);
  const paths = result.map((m) => m.registryPath);

  t.ok(
    paths.includes("bergamot/bergamot-fren/2025/vocab.fren.spm"),
    "companion-referenced vocab kept",
  );
  t.absent(
    paths.includes("other/unrelated.bin"),
    "unreferenced duplicate still dropped",
  );
});

test("deduplicateModels: preserves companion references across different companion sets", (t: {
  ok: Function;
}) => {
  // Two distinct primaries each referencing the same shared vocab path in
  // their own companion sets (e.g. split-vocab scenario in tests). The dedup
  // walker should not touch the vocab since it is companion-referenced.
  const sharedSha = "sharedXsha";
  const primaryA = makeModel({
    registryPath: "setA/model.bin",
    sha256Checksum: "A",
  });
  const primaryB = makeModel({
    registryPath: "setB/model.bin",
    sha256Checksum: "B",
  });
  const vocabA = makeModel({
    registryPath: "setA/vocab.shared.spm",
    sha256Checksum: sharedSha,
  });
  const vocabB = makeModel({
    registryPath: "setB/vocab.shared.spm",
    sha256Checksum: sharedSha,
  });

  // Manually attach companion sets so we do not depend on groupCompanionSets
  // file-naming heuristics.
  const companionSetA: CompanionSetMetadata = {
    setKey: "setA",
    primaryKey: "modelPath",
    files: [
      {
        key: "modelPath",
        registryPath: primaryA.registryPath,
        registrySource: primaryA.registrySource,
        targetName: "model.bin",
        expectedSize: primaryA.expectedSize,
        sha256Checksum: primaryA.sha256Checksum,
        blobCoreKey: primaryA.blobCoreKey,
        blobBlockOffset: primaryA.blobBlockOffset,
        blobBlockLength: primaryA.blobBlockLength,
        blobByteOffset: primaryA.blobByteOffset,
        primary: true,
      },
      {
        key: "sharedVocabPath",
        registryPath: vocabA.registryPath,
        registrySource: vocabA.registrySource,
        targetName: "vocab.shared.spm",
        expectedSize: vocabA.expectedSize,
        sha256Checksum: vocabA.sha256Checksum,
        blobCoreKey: vocabA.blobCoreKey,
        blobBlockOffset: vocabA.blobBlockOffset,
        blobBlockLength: vocabA.blobBlockLength,
        blobByteOffset: vocabA.blobByteOffset,
      },
    ],
  };
  const companionSetB: CompanionSetMetadata = {
    ...companionSetA,
    setKey: "setB",
    files: [
      { ...companionSetA.files[0]!, registryPath: primaryB.registryPath },
      { ...companionSetA.files[1]!, registryPath: vocabB.registryPath },
    ],
  };
  primaryA.companionSet = companionSetA;
  primaryB.companionSet = companionSetB;

  const result = deduplicateModels(
    [primaryA, vocabA, primaryB, vocabB],
    false,
  );
  const paths = result.map((m) => m.registryPath);

  t.ok(paths.includes(vocabA.registryPath), "setA vocab preserved");
  t.ok(paths.includes(vocabB.registryPath), "setB vocab preserved");
});
