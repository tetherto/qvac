import { embed, GTE_LARGE_FP16, loadModel, unloadModel } from "@qvac/sdk";

function cosineSimilarity(vecA: number[], vecB: number[]) {
  let dotProduct = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i]! * vecB[i]!;
  }
  return dotProduct;
}

try {
  const modelId = await loadModel({
    modelSrc: GTE_LARGE_FP16,
    modelType: "embeddings",
    onProgress: (progress) => {
      console.log(progress);
    },
    modelConfig: {
      gpuLayers: 99,
      device: "gpu",
    },
  });

  console.log("\n📝 Example 1: Single Text Embedding");
  console.log("=".repeat(50));

  const singleEmbedding = await embed({ modelId, text: "Hello, world!" });

  console.log("Input: 'Hello, world!'");
  console.log("Embedding dimensions:", singleEmbedding.length);
  console.log("First 10 values:", singleEmbedding.slice(0, 10));

  console.log("\n📝 Example 2: Batch Text Embeddings");
  console.log("=".repeat(50));

  const texts = [
    "The quick brown fox jumps over the lazy dog",
    "A fast auburn fox leaps over a sleepy canine",
    "Python is a programming language",
  ];

  const batchEmbeddings = await embed({ modelId, text: texts });

  console.log("Input: Array of", texts.length, "texts");
  console.log("Output: Array of", batchEmbeddings.length, "embeddings");

  const [emb1, emb2, emb3] = batchEmbeddings;

  if (!emb1 || !emb2 || !emb3) {
    throw new Error("Expected 3 embeddings");
  }

  console.log("Each embedding dimensions:", emb1.length);

  console.log("\n🔍 Similarity Analysis");
  console.log("=".repeat(50));

  const similarity1 = cosineSimilarity(emb1, emb2);
  const similarity2 = cosineSimilarity(emb1, emb3);

  console.log(
    "Similarity between texts 1 and 2 (similar meaning):",
    similarity1.toFixed(4),
  );
  console.log(
    "Similarity between texts 1 and 3 (different topics):",
    similarity2.toFixed(4),
  );
  console.log("\n💡 Higher values indicate more similar meanings");

  await unloadModel({ modelId, clearStorage: false });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
