import {
  loadModel,
  unloadModel,
  GTE_LARGE_FP16,
  ragIngest,
  ragCloseWorkspace,
  cancel,
} from "@qvac/sdk";

const WORKSPACE = "cancellation-demo";

// Generate sample documents
function generateDocuments(count: number): string[] {
  const topics = [
    "Machine learning algorithms process data to identify patterns and make decisions.",
    "Deep neural networks consist of multiple layers that extract higher-level features.",
    "Natural language processing enables computers to understand human language.",
    "Computer vision systems analyze visual information from images and videos.",
    "Reinforcement learning trains agents through trial and error using rewards.",
  ];

  return Array.from({ length: count }, (_, i) => {
    const topic = topics[i % topics.length];
    return `Document ${i + 1}: ${topic} Extended content for document ${i + 1}.`;
  });
}

try {
  console.log("RAG Cancellation Example\n");

  // Load embedding model
  console.log("Loading embedding model...");
  const modelId = await loadModel({
    modelSrc: GTE_LARGE_FP16,
    modelType: "embeddings",
    onProgress: (progress) => {
      process.stdout.write(`\r   ${progress.percentage.toFixed(1)}%`);
    },
  });
  console.log("\n✅ Model loaded\n");

  // Generate documents
  const documents = generateDocuments(200);
  console.log(`📄 Processing ${documents.length} documents...\n`);

  let progressCount = 0;
  let cancelled = false;

  try {
    await ragIngest({
      modelId,
      workspace: WORKSPACE,
      documents,
      progressInterval: 50,
      onProgress: (stage, current, total) => {
        progressCount++;
        const pct = total > 0 ? Math.round((current / total) * 100) : 0;
        console.log(`   [${stage}] ${current}/${total} (${pct}%)`);

        // Cancel during embedding stage after a few updates
        if (!cancelled && stage === "embedding" && current > 10) {
          console.log("\n🛑 Triggering cancellation...\n");
          cancelled = true;
          void cancel({ operation: "rag", workspace: WORKSPACE });
        }
      },
    });

    console.log(
      "\n⚠️  Ingest completed (cancellation didn't interrupt in time)",
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const wasCancelled =
      msg.toLowerCase().includes("cancel") ||
      msg.toLowerCase().includes("abort");

    if (wasCancelled) {
      console.log("✅ Operation cancelled successfully!");
      console.log(`   Progress updates received: ${progressCount}`);
    } else {
      throw error;
    }
  }

  // Cleanup (workspace may not exist if cancelled early)
  await ragCloseWorkspace({ workspace: WORKSPACE, deleteOnClose: true }).catch(
    () => {},
  );

  await unloadModel({ modelId });

  console.log("✅ Done");
  process.exit(0);
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
