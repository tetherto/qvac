import { models } from "./models";

// Re-export all generated models
export * from "./models";

const bciEmbedder = models.find((model) => model.name === "BCI_EMBEDDER")!;

export const BCI_EMBEDDER = {
  name: "BCI_EMBEDDER",
  src: `registry://${bciEmbedder.registrySource}/${bciEmbedder.registryPath}`,
  registryPath: bciEmbedder.registryPath,
  registrySource: bciEmbedder.registrySource,
  blobCoreKey: bciEmbedder.blobCoreKey,
  blobBlockOffset: bciEmbedder.blobBlockOffset,
  blobBlockLength: bciEmbedder.blobBlockLength,
  blobByteOffset: bciEmbedder.blobByteOffset,
  modelId: bciEmbedder.modelId,
  expectedSize: bciEmbedder.expectedSize,
  sha256Checksum: bciEmbedder.sha256Checksum,
  addon: bciEmbedder.addon,
  engine: bciEmbedder.engine,
  quantization: bciEmbedder.quantization,
  params: bciEmbedder.params,
} as const;
