import test from "brittle";
import { embed, GTE_LARGE_FP16 } from "@qvac/bare-sdk";
import { loadResource, unloadAll } from "../_lib/resources.js";

// bare-client unary (single send/response) shape.
test("bare-sdk e2e: embedding over a unary call", async (t) => {
  t.teardown(unloadAll);

  const modelId = await loadResource("embeddings", {
    modelSrc: GTE_LARGE_FP16,
    modelType: "embeddings",
  });

  const { embedding } = await embed({
    modelId,
    text: "Hello world, this is a test of text embedding.",
  });

  t.ok(
    Array.isArray(embedding) && embedding.length > 100,
    `expected a sizable embedding vector, got length=${
      Array.isArray(embedding) ? embedding.length : "n/a"
    }`,
  );
});
