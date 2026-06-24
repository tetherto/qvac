import test from "brittle";
import { embedConfigBaseSchema } from "@/schemas/llamacpp-config";
import {
  loadModelOptionsToRequestSchema,
  loadModelSrcRequestSchema,
} from "@/schemas/load-model";
import { ModelType } from "@/schemas";

const EMBED_BASE = {
  modelType: ModelType.llamacppEmbedding,
  modelSrc: "model.gguf",
};

test("embedConfigBaseSchema: accepts valid splitMode values", (t) => {
  t.is(embedConfigBaseSchema.safeParse({ splitMode: "none" }).success, true);
  t.is(embedConfigBaseSchema.safeParse({ splitMode: "layer" }).success, true);
  t.is(embedConfigBaseSchema.safeParse({ splitMode: "row" }).success, true);
});

test("embedConfigBaseSchema: rejects invalid splitMode values", (t) => {
  t.is(
    embedConfigBaseSchema.safeParse({ splitMode: "column" }).success,
    false,
  );
});

test("embedConfigBaseSchema: splitMode is optional", (t) => {
  t.is(embedConfigBaseSchema.safeParse({}).success, true);
});

test("embedConfigBaseSchema: accepts tensorSplit string", (t) => {
  const result = embedConfigBaseSchema.safeParse({ tensorSplit: "1,1" });
  t.is(result.success, true);
  if (result.success) t.is(result.data.tensorSplit, "1,1");
});

test("embedConfigBaseSchema: accepts mainGpu as integer device index", (t) => {
  const result = embedConfigBaseSchema.safeParse({ mainGpu: 0 });
  t.is(result.success, true);
  if (result.success) t.is(result.data.mainGpu, 0);
});

test("embedConfigBaseSchema: accepts mainGpu as 'integrated' or 'dedicated'", (t) => {
  t.is(
    embedConfigBaseSchema.safeParse({ mainGpu: "integrated" }).success,
    true,
  );
  t.is(
    embedConfigBaseSchema.safeParse({ mainGpu: "dedicated" }).success,
    true,
  );
});

test("embedConfigBaseSchema: rejects mainGpu invalid string", (t) => {
  t.is(embedConfigBaseSchema.safeParse({ mainGpu: "hello" }).success, false);
  t.is(embedConfigBaseSchema.safeParse({ mainGpu: "0" }).success, false);
});

test("loadModelOptionsToRequestSchema: accepts splitMode for embed", (t) => {
  const result = loadModelOptionsToRequestSchema.safeParse({
    ...EMBED_BASE,
    modelConfig: { splitMode: "layer" },
  });
  t.is(result.success, true);
});

test("loadModelOptionsToRequestSchema: accepts mainGpu and tensorSplit for embed", (t) => {
  t.is(
    loadModelOptionsToRequestSchema.safeParse({
      ...EMBED_BASE,
      modelConfig: { splitMode: "layer", tensorSplit: "1,1", mainGpu: 0 },
    }).success,
    true,
  );
  t.is(
    loadModelOptionsToRequestSchema.safeParse({
      ...EMBED_BASE,
      modelConfig: { mainGpu: "integrated" },
    }).success,
    true,
  );
});

test("loadModelOptionsToRequestSchema: rejects mainGpu invalid string for embed", (t) => {
  t.is(
    loadModelOptionsToRequestSchema.safeParse({
      ...EMBED_BASE,
      modelConfig: { mainGpu: "hello" },
    }).success,
    false,
  );
});

test("loadModelSrcRequestSchema: accepts splitMode for embed", (t) => {
  const result = loadModelSrcRequestSchema.safeParse({
    type: "loadModel",
    modelType: ModelType.llamacppEmbedding,
    modelSrc: "model.gguf",
    modelConfig: { splitMode: "row", tensorSplit: "3,1", mainGpu: 0 },
  });
  t.is(result.success, true);
});
