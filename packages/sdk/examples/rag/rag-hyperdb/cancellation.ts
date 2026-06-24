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
  console.log("▸ RAG Cancellation Example");

  // Load embedding model
  console.log("▸ Loading embedding model...");
  const modelId = await loadModel({
    modelSrc: GTE_LARGE_FP16,
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
      if (p.percentage >= 100) process.stderr.write("\n");
    },
  });
  console.log("▸ Model loaded");

  // Generate documents
  const documents = generateDocuments(200);
  console.log(`▸ Processing ${documents.length} documents...`);

  let progressCount = 0;
  let cancelled = false;

  // Capture the decorated promise so we can cancel by `requestId` (the
  // primary cancel path). For a "cancel everything RAG on this model"
  // sweep, use `cancel({ modelId, kind: "rag" })` instead.
  const ingest = ragIngest({
    modelId,
    workspace: WORKSPACE,
    documents,
    progressInterval: 50,
    onProgress: (stage, current, total) => {
      progressCount++;
      console.log(`▸ ${stage} ${current}/${total}`);

      if (!cancelled && stage === "embedding" && current > 10) {
        console.log("▸ Triggering cancellation...");
        cancelled = true;
        void cancel({ requestId: ingest.requestId });
      }
    },
  });

  try {
    await ingest;
    console.log("▸ Ingest completed (cancellation didn't interrupt in time)");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const wasCancelled =
      msg.toLowerCase().includes("cancel") ||
      msg.toLowerCase().includes("abort");

    if (wasCancelled) {
      console.log("▸ Operation cancelled successfully!");
      console.log(`▸ Progress updates received: ${progressCount}`);
    } else {
      throw error;
    }
  }

  // Cleanup (workspace may not exist if cancelled early)
  await ragCloseWorkspace({ workspace: WORKSPACE, deleteOnClose: true }).catch(
    () => {},
  );

  await unloadModel({ modelId });

  console.log("▸ Done");
  process.exit(0);
} catch (error) {
  console.error("✖", error);
  process.exit(1);
}
