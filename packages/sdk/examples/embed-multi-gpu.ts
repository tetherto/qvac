import {
  loadModel,
  embed,
  unloadModel,
  EMBEDDINGGEMMA_300M_Q8_0,
} from "@qvac/sdk";

// Multi-GPU embedding distributes model layers across multiple GPUs using
// llama.cpp's built-in split modes. Two strategies are available:
//
// - "layer": splits layers and KV cache across GPUs.
// - "row":   splits layers and KV cache across GPUs, and uses tensor parallelism
//            where supported.
//
// tensorSplit controls the proportion of work assigned to each GPU.
// "1,1" distributes evenly across two GPUs; "3,1" assigns 75% to GPU 0.
//
// mainGpu selects which GPU is used for the entire model when splitMode is
// "none", and pins the primary device in multi-GPU mode.
// Accepts an integer device index (0, 1, ...) or "integrated" / "dedicated".

try {
  const modelId = await loadModel({
    modelSrc: EMBEDDINGGEMMA_300M_Q8_0,
    modelConfig: {
      splitMode: "layer",
      tensorSplit: "1,1",
      mainGpu: 0,
      gpuLayers: 99,
      verbosity: 0,
    },
  });

  const texts = [
    "Multi-GPU embedding distributes layer computation across GPUs.",
    "Each GPU handles a subset of layers, improving throughput for large models.",
    "The tensor-split ratio controls how much work each GPU receives.",
  ];

  for (const text of texts) {
    const { embedding, stats } = await embed({ modelId, text });
    console.log(`Embedded ${text.slice(0, 50)}...`);
    console.log(`  Dimensions: ${embedding.length}`);
    if (stats) {
      console.log(
        `  Backend: ${stats.backendDevice}, TPS: ${stats.tokensPerSecond?.toFixed(1)}`,
      );
    }
  }

  await unloadModel({ modelId, clearStorage: false });
  process.exit(0);
} catch (error) {
  console.error("Error:", error);
  process.exit(1);
}
