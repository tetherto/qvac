import {
  qvacModelRegistryList,
  qvacModelRegistrySearch,
  qvacModelRegistryFindByEngine,
  qvacModelRegistryFindByName,
  qvacModelRegistryFindByQuantization,
  qvacModelRegistryFindByModelType,
  qvacModelRegistryGetModel,
  close,
  type QvacModelRegistryEntry,
} from "@qvac/sdk";

try {
  console.log("QVAC Model Registry Query Examples\n");

  // List all available models
  console.log("Listing all models in QVAC model registry...");
  const allModels = await qvacModelRegistryList();
  console.log(`   Found ${allModels.length} models in registry\n`);

  // Show first 5 models as sample
  console.log("   Sample models:");
  allModels.slice(0, 5).forEach((model) => {
    console.log(
      `   - ${model.name} (${model.addon}, ${model.engine}, ${formatSize(model.expectedSize)})`,
    );
  });
  console.log();

  // Search with filter
  console.log('Searching for "whisper" models...');
  const whisperModels = await qvacModelRegistrySearch({ filter: "whisper" });
  console.log(`   Found ${whisperModels.length} whisper-related models\n`);

  // Find by engine
  console.log("Finding models by engine (@qvac/embed-llamacpp)...");
  const embedModels = await qvacModelRegistryFindByEngine(
    "@qvac/embed-llamacpp",
  );
  console.log(`   Found ${embedModels.length} embedding models`);
  embedModels.slice(0, 3).forEach((model) => {
    console.log(`   - ${model.name} (${model.quantization})`);
  });
  console.log();

  // Find by quantization
  console.log("Finding Q4_0 quantized models...");
  const q4Models = await qvacModelRegistryFindByQuantization("q4");
  console.log(`   Found ${q4Models.length} Q4 quantized models`);
  q4Models.slice(0, 3).forEach((model) => {
    console.log(`   - ${model.name}`);
  });
  console.log();

  // Find by name
  console.log('Finding models by name containing "llama"...');
  const llamaModels = await qvacModelRegistryFindByName("llama");
  console.log(`   Found ${llamaModels.length} llama models`);
  llamaModels.slice(0, 3).forEach((model) => {
    console.log(`   - ${model.name} (${model.addon})`);
  });
  console.log();

  // Find by model type
  console.log("Finding transcription models by model type...");
  const transcriptionModels = await qvacModelRegistryFindByModelType("whisper");
  console.log(`   Found ${transcriptionModels.length} transcription models`);
  transcriptionModels.slice(0, 3).forEach((model: QvacModelRegistryEntry) => {
    console.log(`   - ${model.name}`);
  });
  console.log();

  // Find LLM models by model type
  console.log("Finding LLM models by model type...");
  const llmModels = await qvacModelRegistryFindByModelType("llm");
  console.log(`   Found ${llmModels.length} LLM models`);
  llmModels.slice(0, 3).forEach((model: QvacModelRegistryEntry) => {
    console.log(`   - ${model.name} (${model.quantization})`);
  });
  console.log();

  // Get specific model (if we have at least one model)
  const sampleModel = allModels[0];
  if (sampleModel) {
    console.log(
      `Getting specific model: ${sampleModel.registrySource}/${sampleModel.registryPath}`,
    );
    const model = await qvacModelRegistryGetModel(
      sampleModel.registryPath,
      sampleModel.registrySource,
    );
    console.log("   Model details:");
    console.log(`   - Name: ${model.name}`);
    console.log(`   - Addon: ${model.addon}`);
    console.log(`   - Engine: ${model.engine}`);
    console.log(`   - Quantization: ${model.quantization}`);
    console.log(`   - Expected size: ${formatSize(model.expectedSize)}`);
    console.log(`   - Checksum: ${model.sha256Checksum.slice(0, 16)}...`);
    console.log();
  }

  console.log("QVAC model registry query examples completed successfully!");

  close();
  process.exit(0);
} catch (error) {
  console.error("Error:", error);
  process.exit(1);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}
