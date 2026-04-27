// @ts-expect-error brittle has no type declarations
import test from "brittle";
import { llmConfigBaseSchema } from "@/schemas/llamacpp-config";

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
  t.is(llmConfigBaseSchema.safeParse({ "split-mode": "" }).success, false);
});

test("llmConfigBaseSchema: split-mode is optional", (t) => {
  t.is(llmConfigBaseSchema.safeParse({}).success, true);
});

test("llmConfigBaseSchema: accepts tensor-split string", (t) => {
  const result = llmConfigBaseSchema.safeParse({ "tensor-split": "1,1" });
  t.is(result.success, true);
  if (result.success) t.is(result.data["tensor-split"], "1,1");
});

test("llmConfigBaseSchema: accepts split-mode and tensor-split together", (t) => {
  const result = llmConfigBaseSchema.safeParse({
    "split-mode": "layer",
    "tensor-split": "3,1",
  });
  t.is(result.success, true);
  if (result.success) {
    t.is(result.data["split-mode"], "layer");
    t.is(result.data["tensor-split"], "3,1");
  }
});
