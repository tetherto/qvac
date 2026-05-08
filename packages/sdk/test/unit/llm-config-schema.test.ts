// @ts-expect-error brittle has no type declarations
import test from "brittle";
import { llmConfigBaseSchema } from "@/schemas/llamacpp-config";
import {
  loadModelOptionsToRequestSchema,
  loadModelSrcRequestSchema,
} from "@/schemas/load-model";
import { ModelType } from "@/schemas";

const LLM_BASE = {
  modelType: ModelType.llamacppCompletion,
  modelSrc: "model.gguf",
};

test("llmConfigBaseSchema: accepts valid split-mode values", (t) => {
  t.is(llmConfigBaseSchema.safeParse({ "split-mode": "none" }).success, true);
  t.is(llmConfigBaseSchema.safeParse({ "split-mode": "layer" }).success, true);
  t.is(llmConfigBaseSchema.safeParse({ "split-mode": "row" }).success, true);
});

test("llmConfigBaseSchema: rejects invalid split-mode values", (t) => {
  t.is(
    llmConfigBaseSchema.safeParse({ "split-mode": "column" }).success,
    false,
  );
});

test("llmConfigBaseSchema: split-mode is optional", (t) => {
  t.is(llmConfigBaseSchema.safeParse({}).success, true);
});

test("llmConfigBaseSchema: accepts tensor-split string", (t) => {
  const result = llmConfigBaseSchema.safeParse({ "tensor-split": "1,1" });
  t.is(result.success, true);
  if (result.success) t.is(result.data["tensor-split"], "1,1");
});

test("llmConfigBaseSchema: accepts main-gpu as integer device index", (t) => {
  const result = llmConfigBaseSchema.safeParse({ "main-gpu": 0 });
  t.is(result.success, true);
  if (result.success) t.is(result.data["main-gpu"], 0);
});

test("llmConfigBaseSchema: accepts main-gpu as 'integrated' or 'dedicated'", (t) => {
  t.is(
    llmConfigBaseSchema.safeParse({ "main-gpu": "integrated" }).success,
    true,
  );
  t.is(
    llmConfigBaseSchema.safeParse({ "main-gpu": "dedicated" }).success,
    true,
  );
});

test("llmConfigBaseSchema: rejects main-gpu invalid string", (t) => {
  t.is(llmConfigBaseSchema.safeParse({ "main-gpu": "hello" }).success, false);
  t.is(llmConfigBaseSchema.safeParse({ "main-gpu": "0" }).success, false);
});

test("loadModelOptionsToRequestSchema: accepts split-mode for LLM", (t) => {
  const result = loadModelOptionsToRequestSchema.safeParse({
    ...LLM_BASE,
    modelConfig: { "split-mode": "layer" },
  });
  t.is(result.success, true);
});

test("loadModelOptionsToRequestSchema: accepts main-gpu integer and named GPUs for LLM", (t) => {
  t.is(
    loadModelOptionsToRequestSchema.safeParse({
      ...LLM_BASE,
      modelConfig: { "split-mode": "layer", "tensor-split": "1,1", "main-gpu": 0 },
    }).success,
    true,
  );
  t.is(
    loadModelOptionsToRequestSchema.safeParse({
      ...LLM_BASE,
      modelConfig: { "main-gpu": "integrated" },
    }).success,
    true,
  );
});

test("loadModelOptionsToRequestSchema: rejects main-gpu invalid string for LLM", (t) => {
  t.is(
    loadModelOptionsToRequestSchema.safeParse({
      ...LLM_BASE,
      modelConfig: { "main-gpu": "hello" },
    }).success,
    false,
  );
});

test("loadModelSrcRequestSchema: accepts split-mode for LLM", (t) => {
  const result = loadModelSrcRequestSchema.safeParse({
    type: "loadModel",
    modelType: ModelType.llamacppCompletion,
    modelSrc: "model.gguf",
    modelConfig: { "split-mode": "row", "tensor-split": "3,1", "main-gpu": 0 },
  });
  t.is(result.success, true);
});
