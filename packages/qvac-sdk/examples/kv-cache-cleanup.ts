import {
  completion,
  deleteCache,
  LLAMA_3_2_1B_INST_Q4_0,
  loadModel,
  unloadModel,
  VERBOSITY,
} from "@qvac/sdk";

try {
  console.log("🧹 KV Cache Cleanup Demo\n");
  console.log("Cache structure: {kvCacheKey}/{modelId}/{configHash}.bin\n");
  console.log("=".repeat(70) + "\n");

  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelType: "llm",
    modelConfig: {
      device: "gpu",
      ctx_size: 2048,
      verbosity: VERBOSITY.ERROR,
    },
  });

  // Create some cached sessions
  const cacheKey1 = "user-alice-session";
  const cacheKey2 = "user-bob-session";

  console.log(`📝 Creating cache for key: "${cacheKey1}"`);
  const result1 = completion({
    modelId,
    history: [{ role: "user", content: "Hello, I'm Alice!" }],
    stream: true,
    kvCache: cacheKey1,
  });

  for await (const token of result1.tokenStream) {
    process.stdout.write(token);
  }
  console.log("\n✅ Cache created\n");

  console.log(`📝 Creating cache for key: "${cacheKey2}"`);
  const result2 = completion({
    modelId,
    history: [{ role: "user", content: "Hello, I'm Bob!" }],
    stream: true,
    kvCache: cacheKey2,
  });

  for await (const token of result2.tokenStream) {
    process.stdout.write(token);
  }
  console.log("\n✅ Cache created\n");

  // Now cleanup specific cache key
  console.log("=".repeat(70));
  console.log(`\n🗑️  Deleting cache key: "${cacheKey1}"`);
  const deleteResult1 = await deleteCache({ kvCacheKey: cacheKey1 });

  if (deleteResult1.success) {
    console.log(`✅ Deleted all caches for key "${cacheKey1}"`);
    console.log(`   (Removed: ${cacheKey1}/{modelId}/{configHash}.bin)`);
  }

  // Delete specific model within a cache key
  console.log(`\n🗑️  Deleting specific model in cache key: "${cacheKey2}"`);
  const deleteResult2 = await deleteCache({
    kvCacheKey: cacheKey2,
    modelId: modelId,
  });

  if (deleteResult2.success) {
    console.log(`✅ Deleted model "${modelId}" from cache key "${cacheKey2}"`);
    console.log(`   (Removed: ${cacheKey2}/${modelId}/)`);
  }

  // Try to delete non-existent cache key (should succeed silently)
  console.log(`\n🗑️  Deleting non-existent cache key: "non-existent"`);
  const deleteResult3 = await deleteCache({ kvCacheKey: "non-existent" });

  if (deleteResult3.success) {
    console.log("✅ Delete succeeded (cache key didn't exist)");
  }

  console.log("\n" + "=".repeat(70));
  console.log("\n✅ CLEANUP OPTIONS:");
  console.log("-".repeat(70));
  console.log("\n1️⃣  Delete entire cache key (all models):");
  console.log('   await deleteCache({ kvCacheKey: "my-session" })');
  console.log("   └─ Removes: my-session/ (entire directory)");
  console.log("\n2️⃣  Delete specific model within cache key:");
  console.log(
    '   await deleteCache({ kvCacheKey: "my-session", modelId: "model-abc" })',
  );
  console.log(
    "   └─ Removes: my-session/model-abc/ (specific model directory)",
  );
  console.log("\n3️⃣  Delete ALL caches (entire cache folder):");
  console.log("   await deleteCache({ all: true })");
  console.log("   └─ Removes: ALL cache files from all sessions and models");
  console.log("\n💡 Use Cases:");
  console.log("   - User logout → Delete user's cache key");
  console.log("   - Model updated → Delete old model caches");
  console.log("   - Disk space cleanup → Delete old cache keys or all caches");
  console.log("   - Privacy → Clear conversation history");
  console.log("   - App reset → Delete all caches with { all: true }");

  await unloadModel({ modelId, clearStorage: false });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
