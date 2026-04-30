import {
  modelRegistryList,
  modelRegistrySearch,
  modelRegistryGetModel,
  ModelType,
  close,
  type ModelRegistryEntry,
} from "@qvac/sdk";

try {
  console.log("QVAC Model Registry Query Examples\n");

  // List all available models
  console.log("Listing all models in QVAC model registry...");
  const allModels = await modelRegistryList();
  console.log(`   Found ${allModels.length} models in registry\n`);

  // Show first 5 models as sample
  console.log("   Sample models:");
  allModels.slice(0, 5).forEach((model) => {
    console.log(
      `   - ${model.name} (${model.addon}, ${model.engine}, ${formatSize(model.expectedSize)})`,
    );
  });
  console.log();

  // Search with text filter
  console.log('Searching for "whisper" models...');
  const whisperModels = await modelRegistrySearch({ filter: "whisper" });
  console.log(`   Found ${whisperModels.length} whisper-related models\n`);

  // Search by engine (using canonical ModelType enum)
  console.log(`Searching by engine (${ModelType.llamacppEmbedding})...`);
  const embedModels = await modelRegistrySearch({
    engine: ModelType.llamacppEmbedding,
  });
  console.log(`   Found ${embedModels.length} embedding models`);
  embedModels.slice(0, 3).forEach((model) => {
    console.log(`   - ${model.name} (${model.quantization})`);
  });
  console.log();

  // Search by quantization
  console.log("Searching for Q4 quantized models...");
  const q4Models = await modelRegistrySearch({ quantization: "q4" });
  console.log(`   Found ${q4Models.length} Q4 quantized models`);
  q4Models.slice(0, 3).forEach((model) => {
    console.log(`   - ${model.name}`);
  });
  console.log();

  // Search by addon/model type
  console.log("Searching for transcription models...");
  const transcriptionModels = await modelRegistrySearch({
    addon: "whisper",
  });
  console.log(`   Found ${transcriptionModels.length} transcription models`);
  transcriptionModels.slice(0, 3).forEach((model: ModelRegistryEntry) => {
    console.log(`   - ${model.name}`);
  });
  console.log();

  // Combined search: engine + quantization
  console.log("Searching for Q4 LLM models...");
  const q4LlmModels = await modelRegistrySearch({
    engine: ModelType.llamacppCompletion,
    quantization: "q4",
  });
  console.log(`   Found ${q4LlmModels.length} Q4 LLM models`);
  q4LlmModels.slice(0, 3).forEach((model: ModelRegistryEntry) => {
    console.log(`   - ${model.name} (${model.quantization})`);
  });
  console.log();

  // Get specific model (if we have at least one model)
  const sampleModel = allModels[0];
  if (sampleModel) {
    console.log(
      `Getting specific model: ${sampleModel.registrySource}/${sampleModel.registryPath}`,
    );
    const model = await modelRegistryGetModel(
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

  void close();
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
