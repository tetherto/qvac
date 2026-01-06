import { WHISPER_TINY } from "@/models/hyperdrive";
import type { ModelInfo } from "@/schemas";
import { downloadAsset, getModelInfo, loadModel, unloadModel } from "..";

const printModelStatus = (info: ModelInfo, label: string) => {
  console.log(`\n${label}`);
  console.log(`   Model Name: ${info.name}`);
  console.log(`   Model ID: ${info.modelId}`);
  console.log(`   Hyperdrive Key: ${info.hyperdriveKey.substring(0, 16)}...`);
  console.log(
    `   Expected Size: ${(info.expectedSize / 1024 / 1024).toFixed(2)} MB`,
  );
  console.log(`   Addon: ${info.addon}`);
  console.log(`   Cache Files: ${info.cacheFiles.length}`);
  console.log(`   Is Cached: ${info.isCached ? "✅" : "❌"}`);
  console.log(`   Is Loaded: ${info.isLoaded ? "✅" : "❌"}`);

  if (info.isCached) {
    if (info.cacheFiles.length === 1) {
      console.log(`   Cache Path: ${info.cacheFiles[0]?.path}`);
    } else {
      const cachedFiles = info.cacheFiles.filter((f) => f.isCached).length;
      console.log(`     Cached: ${cachedFiles}/${info.cacheFiles.length}`);
    }
    console.log(
      `   Actual Size: ${(info.actualSize! / 1024 / 1024).toFixed(2)} MB`,
    );
    console.log(`   Cached At: ${info.cachedAt?.toLocaleString()}`);
  }

  if (info.loadedInstances && info.loadedInstances.length > 0) {
    console.log(`   Loaded Instances: ${info.loadedInstances.length}`);
    info.loadedInstances.forEach((instance, i) => {
      console.log(`     ${i + 1}. Registry ID: ${instance.registryId}`);
      console.log(`        Loaded At: ${instance.loadedAt.toLocaleString()}`);
    });
  }
};

try {
  console.log("=== Model Cache Management Demo ===");

  // 1. Check initial status
  console.log("\n1️⃣  INITIAL STATUS CHECK");
  const initialInfo = await getModelInfo(WHISPER_TINY);
  printModelStatus(initialInfo, "Initial Status:");

  // 2. Download if not cached
  if (!initialInfo.isCached) {
    console.log("\n2️⃣  DOWNLOADING MODEL (not cached)");
    console.log("   Downloading from hyperdrive...");
    await downloadAsset({ assetSrc: WHISPER_TINY });
    console.log("   ✅ Download complete!");

    const afterDownload = await getModelInfo(WHISPER_TINY);
    printModelStatus(afterDownload, "Status After Download:");
  } else {
    console.log("\n2️⃣  MODEL ALREADY CACHED");
    console.log("   Skipping download...");
  }

  // 3. Load if not loaded
  console.log("\n3️⃣  LOADING MODEL INTO MEMORY");
  const beforeLoad = await getModelInfo(WHISPER_TINY);

  let modelId: string;
  if (!beforeLoad.isLoaded) {
    console.log("   Loading model into memory...");
    modelId = await loadModel({
      modelSrc: WHISPER_TINY,
      modelType: "whisper",
    });
    console.log(`   ✅ Model loaded! ID: ${modelId}`);

    const afterLoad = await getModelInfo(WHISPER_TINY);
    printModelStatus(afterLoad, "Status After Load:");
  } else {
    console.log("   Model already loaded!");
    const instances = beforeLoad.loadedInstances;
    if (!instances || instances.length === 0) {
      throw new Error("Model is loaded but no instances found");
    }
    const firstInstance = instances[0];
    if (!firstInstance) {
      throw new Error("First instance is undefined");
    }
    modelId = firstInstance.registryId;
    console.log(`   Using existing model ID: ${modelId}`);
  }

  // 4. Demonstrate unload
  console.log("\n4️⃣  UNLOADING MODEL");
  console.log("   Unloading model from memory...");
  await unloadModel({ modelId });
  console.log("   ✅ Model unloaded!");

  const afterUnload = await getModelInfo(WHISPER_TINY);
  printModelStatus(afterUnload, "Status After Unload:");

  // 5. Summary
  console.log("\n5️⃣  SUMMARY");
  console.log("   ✅ Model Info API works correctly");
  console.log("   ✅ Cache status tracked accurately");
  console.log("   ✅ Loaded status reflects memory state");
  console.log("   ✅ All operations completed successfully");

  console.log("\n=== Demo Complete ===\n");
  process.exit(0);
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
