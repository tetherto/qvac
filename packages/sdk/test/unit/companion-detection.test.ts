// @ts-expect-error brittle has no type declarations
import test from "brittle";
import { groupCompanionSets } from "@/models/update-models/companions";
import type { ProcessedModel } from "@/models/update-models/types";

function makeModel(
  overrides: Partial<ProcessedModel> & { registryPath: string },
): ProcessedModel {
  return {
    registrySource: "hf",
    modelId: overrides.registryPath.split("/").pop() || "",
    addon: "parakeet",
    engine: "parakeet-transcription",
    modelName: "test",
    quantization: "fp32",
    params: "",
    tags: [],
    expectedSize: 1000,
    sha256Checksum: "abc123",
    blobCoreKey: "key",
    blobBlockOffset: 0,
    blobBlockLength: 1,
    blobByteOffset: 0,
    ...overrides,
  };
}

test("groupCompanionSets: pairs .onnx with _data companion", (t: { ok: Function; is: Function; absent: Function }) => {
  const primary = makeModel({ registryPath: "repo/model.onnx" });
  const data = makeModel({ registryPath: "repo/model.onnx_data" });

  const result = groupCompanionSets([primary, data]);

  t.ok(result[0]!.companionSet, "primary has companionSet");
  t.is(result[0]!.companionSet!.primaryKey, "modelPath");
  t.is(result[0]!.companionSet!.files.length, 2);
  t.is(result[0]!.companionSet!.files[0]!.primary, true);
  t.is(result[0]!.companionSet!.files[0]!.targetName, "model.onnx");
  t.is(result[0]!.companionSet!.files[1]!.targetName, "model.onnx_data");
  t.absent(result[0]!.isCompanionOnly);
  t.is(result[1]!.isCompanionOnly, true);
});

test("groupCompanionSets: pairs .onnx with .data companion", (t: { ok: Function; is: Function }) => {
  const primary = makeModel({ registryPath: "repo/encoder.onnx" });
  const data = makeModel({ registryPath: "repo/encoder.onnx.data" });

  const result = groupCompanionSets([primary, data]);

  t.ok(result[0]!.companionSet, "primary has companionSet");
  t.is(result[0]!.companionSet!.files[1]!.targetName, "encoder.onnx.data");
  t.is(result[1]!.isCompanionOnly, true);
});

test("groupCompanionSets: onnx without companion gets no companionSet", (t: { is: Function; absent: Function }) => {
  const standalone = makeModel({ registryPath: "repo/decoder.onnx" });

  const result = groupCompanionSets([standalone]);

  t.absent(result[0]!.companionSet);
  t.absent(result[0]!.isCompanionOnly);
  t.is(result.length, 1);
});

test("groupCompanionSets: non-onnx files are skipped", (t: { absent: Function }) => {
  const gguf = makeModel({ registryPath: "repo/model.gguf" });
  const bin = makeModel({ registryPath: "repo/vocab.txt" });

  const result = groupCompanionSets([gguf, bin]);

  t.absent(result[0]!.companionSet);
  t.absent(result[0]!.isCompanionOnly);
  t.absent(result[1]!.companionSet);
  t.absent(result[1]!.isCompanionOnly);
});

test("groupCompanionSets: cross-source models are not paired", (t: { absent: Function }) => {
  const primary = makeModel({
    registryPath: "repo/model.onnx",
    registrySource: "hf",
  });
  const data = makeModel({
    registryPath: "repo/model.onnx_data",
    registrySource: "github",
  });

  const result = groupCompanionSets([primary, data]);

  t.absent(result[0]!.companionSet);
  t.absent(result[0]!.isCompanionOnly);
  t.absent(result[1]!.isCompanionOnly);
});

test("groupCompanionSets: setKey is deterministic", (t: { ok: Function; is: Function }) => {
  const primary = makeModel({ registryPath: "repo/model.onnx" });
  const data = makeModel({ registryPath: "repo/model.onnx_data" });

  const result1 = groupCompanionSets([{ ...primary }, { ...data }]);
  const result2 = groupCompanionSets([{ ...primary }, { ...data }]);

  t.ok(result1[0]!.companionSet!.setKey);
  t.is(result1[0]!.companionSet!.setKey, result2[0]!.companionSet!.setKey);
  t.is(result1[0]!.companionSet!.setKey.length, 16);
});

// --- Bergamot companion detection ---

test("groupCompanionSets: bergamot shared vocab (4-file set)", (t: { ok: Function; is: Function; absent: Function }) => {
  const dir = "bergamot/bergamot-enfr/2025-01-01/";
  const model = makeModel({ registryPath: `${dir}model.enfr.intgemm.alphas.bin` });
  const lex = makeModel({ registryPath: `${dir}lex.50.50.enfr.s2t.bin` });
  const vocab = makeModel({ registryPath: `${dir}vocab.enfr.spm` });
  const meta = makeModel({ registryPath: `${dir}metadata.json` });

  const result = groupCompanionSets([model, lex, vocab, meta]);

  t.ok(result[0]!.companionSet, "primary has companionSet");
  t.is(result[0]!.companionSet!.primaryKey, "modelPath");
  t.is(result[0]!.companionSet!.files.length, 4);
  t.is(result[0]!.companionSet!.files[0]!.primary, true);
  t.is(result[0]!.companionSet!.files[0]!.targetName, "model.enfr.intgemm.alphas.bin");
  t.absent(result[0]!.isCompanionOnly);
  t.is(result[1]!.isCompanionOnly, true);
  t.is(result[2]!.isCompanionOnly, true);
  t.is(result[3]!.isCompanionOnly, true);

  const keys = result[0]!.companionSet!.files.map((f) => f.key);
  t.is(keys[0], "modelPath");
  t.is(keys[1], "lexPath");
  t.is(keys[2], "sharedVocabPath");
  t.is(keys[3], "metadataPath");
});

test("groupCompanionSets: bergamot split vocab CJK (5-file set)", (t: { ok: Function; is: Function }) => {
  const dir = "bergamot/bergamot-enja/2025-01-01/";
  const model = makeModel({ registryPath: `${dir}model.enja.intgemm.alphas.bin` });
  const lex = makeModel({ registryPath: `${dir}lex.50.50.enja.s2t.bin` });
  const srcVocab = makeModel({ registryPath: `${dir}srcvocab.enja.spm` });
  const trgVocab = makeModel({ registryPath: `${dir}trgvocab.enja.spm` });
  const meta = makeModel({ registryPath: `${dir}metadata.json` });

  const result = groupCompanionSets([model, lex, srcVocab, trgVocab, meta]);

  t.ok(result[0]!.companionSet, "primary has companionSet");
  t.is(result[0]!.companionSet!.files.length, 5);

  const keys = result[0]!.companionSet!.files.map((f) => f.key);
  t.ok(keys.includes("srcVocabPath"), "has srcVocabPath");
  t.ok(keys.includes("dstVocabPath"), "has dstVocabPath");
  t.is(result[2]!.isCompanionOnly, true);
  t.is(result[3]!.isCompanionOnly, true);
});

test("groupCompanionSets: bergamot no-vocab (3-file set)", (t: { ok: Function; is: Function }) => {
  const dir = "bergamot/bergamot-aren/2025-01-01/";
  const model = makeModel({ registryPath: `${dir}model.aren.intgemm.alphas.bin` });
  const lex = makeModel({ registryPath: `${dir}lex.50.50.aren.s2t.bin` });
  const meta = makeModel({ registryPath: `${dir}metadata.json` });

  const result = groupCompanionSets([model, lex, meta]);

  t.ok(result[0]!.companionSet, "primary has companionSet");
  t.is(result[0]!.companionSet!.files.length, 3);
});

test("groupCompanionSets: bergamot model without companions gets no set", (t: { absent: Function }) => {
  const model = makeModel({
    registryPath: "bergamot/bergamot-xxxx/model.xxxx.intgemm.alphas.bin",
  });

  const result = groupCompanionSets([model]);

  t.absent(result[0]!.companionSet);
  t.absent(result[0]!.isCompanionOnly);
});

test("groupCompanionSets: bergamot cross-source not paired", (t: { absent: Function }) => {
  const dir = "bergamot/bergamot-enfr/2025-01-01/";
  const model = makeModel({
    registryPath: `${dir}model.enfr.intgemm.alphas.bin`,
    registrySource: "s3",
  });
  const lex = makeModel({
    registryPath: `${dir}lex.50.50.enfr.s2t.bin`,
    registrySource: "github",
  });

  const result = groupCompanionSets([model, lex]);

  t.absent(result[0]!.companionSet);
});

