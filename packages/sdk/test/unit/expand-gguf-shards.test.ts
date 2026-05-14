// @ts-expect-error brittle has no type declarations
import test from "brittle";
import { expandGGUFIntoShards } from "@/server/utils/expand-gguf-shards";

test("expandGGUFIntoShards: returns single path for non-sharded model", (t) => {
  const result = expandGGUFIntoShards("/models/llama-7b.gguf");
  t.alike(result, ["/models/llama-7b.gguf"]);
});

test("expandGGUFIntoShards: returns single path for non-gguf file", (t) => {
  const result = expandGGUFIntoShards("/models/something.bin");
  t.alike(result, ["/models/something.bin"]);
});

test("expandGGUFIntoShards: expands sharded model when given first shard", (t) => {
  const result = expandGGUFIntoShards(
    "/models/medgemma-4b-it-Q4_1-00001-of-00005.gguf",
  );
  t.is(result.length, 6, "tensors.txt + 5 shards");
  t.is(result[0], "/models/medgemma-4b-it-Q4_1.tensors.txt");
  t.is(result[1], "/models/medgemma-4b-it-Q4_1-00001-of-00005.gguf");
  t.is(result[5], "/models/medgemma-4b-it-Q4_1-00005-of-00005.gguf");
});

test("expandGGUFIntoShards: expands sharded model when given a non-first shard", (t) => {
  const result = expandGGUFIntoShards(
    "/models/medgemma-4b-it-Q4_1-00003-of-00005.gguf",
  );
  t.is(result.length, 6);
  t.is(result[0], "/models/medgemma-4b-it-Q4_1.tensors.txt");
  for (let i = 1; i <= 5; i++) {
    t.is(
      result[i],
      `/models/medgemma-4b-it-Q4_1-${String(i).padStart(5, "0")}-of-00005.gguf`,
    );
  }
});

test("expandGGUFIntoShards: preserves nested directory in returned paths", (t) => {
  const result = expandGGUFIntoShards(
    "/some/nested/dir/Qwen3-1.7B-Q4_0-00001-of-00002.gguf",
  );
  t.is(result.length, 3);
  t.is(result[0], "/some/nested/dir/Qwen3-1.7B-Q4_0.tensors.txt");
  t.is(result[1], "/some/nested/dir/Qwen3-1.7B-Q4_0-00001-of-00002.gguf");
  t.is(result[2], "/some/nested/dir/Qwen3-1.7B-Q4_0-00002-of-00002.gguf");
});

test("expandGGUFIntoShards: handles single-shard sharded model (1-of-1)", (t) => {
  const result = expandGGUFIntoShards("/models/tiny-00001-of-00001.gguf");
  t.is(result.length, 2);
  t.is(result[0], "/models/tiny.tensors.txt");
  t.is(result[1], "/models/tiny-00001-of-00001.gguf");
});

test("expandGGUFIntoShards: handles relative path without directory", (t) => {
  const result = expandGGUFIntoShards("model-00001-of-00002.gguf");
  t.is(result.length, 3);
  t.is(result[0], "model.tensors.txt");
  t.is(result[1], "model-00001-of-00002.gguf");
  t.is(result[2], "model-00002-of-00002.gguf");
});

test("expandGGUFIntoShards: handles Windows-style backslash separators", (t) => {
  const result = expandGGUFIntoShards(
    "C:\\models\\llama-00001-of-00003.gguf",
  );
  t.is(result.length, 4);
  t.is(result[0], "C:\\models\\llama.tensors.txt");
  t.is(result[1], "C:\\models\\llama-00001-of-00003.gguf");
  t.is(result[3], "C:\\models\\llama-00003-of-00003.gguf");
});

test("expandGGUFIntoShards: does not match shard-like substring before extension", (t) => {
  const result = expandGGUFIntoShards(
    "/models/foo-00001-of-00002-baseline.gguf",
  );
  t.alike(result, ["/models/foo-00001-of-00002-baseline.gguf"]);
});

test("expandGGUFIntoShards: returns input for zero-total shard count", (t) => {
  const result = expandGGUFIntoShards("/models/empty-00000-of-00000.gguf");
  t.alike(result, ["/models/empty-00000-of-00000.gguf"]);
});
