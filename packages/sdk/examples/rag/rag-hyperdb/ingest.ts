import {
  loadModel,
  unloadModel,
  GTE_LARGE_FP16,
  ragIngest,
  ragSearch,
  ragCloseWorkspace,
} from "@qvac/sdk";

try {
  // Get query from command line or use default
  const query = process.argv[2] || "machine learning algorithms";
  const workspace = "ingest-example";

  console.log(`🔍 Query: "${query}"`);
  const modelId = await loadModel({
    modelSrc: GTE_LARGE_FP16,
    modelType: "embeddings",
    onProgress: (progress) => {
      console.log(`Loading model... ${progress.percentage.toFixed(1)}%`);
    },
  });

  const samples = [
    "Machine learning is a subset of artificial intelligence that focuses on algorithms that can learn and make predictions from data without being explicitly programmed for every task.",
    "Deep learning uses neural networks with multiple layers to process and learn from complex data patterns, enabling breakthroughs in image recognition and natural language processing.",
    "Natural language processing combines computational linguistics with machine learning to help computers understand, interpret, and generate human language in a meaningful way.",
    "Computer vision enables machines to interpret and understand visual information from the world, using techniques like image classification, object detection, and facial recognition.",
    "Quantum computing leverages quantum mechanical phenomena to process information in fundamentally different ways than classical computers, potentially solving certain problems exponentially faster.",
    "Blockchain technology creates decentralized, immutable ledgers that enable secure peer-to-peer transactions without requiring a central authority or intermediary.",
    "Cloud computing delivers computing services over the internet, allowing users to access resources like storage, processing power, and applications on-demand from anywhere.",
    "Cybersecurity protects digital systems, networks, and data from malicious attacks, unauthorized access, and various forms of cyber threats through multiple layers of defense.",
  ];

  console.log("📚 Ingesting documents...");
  const result = await ragIngest({
    modelId,
    workspace,
    documents: samples,
    chunk: false,
  });
  console.log(`✅ Ingested ${result.processed.length} documents`);

  console.log("🔎 Searching for similar documents...");
  const results = await ragSearch({
    modelId,
    workspace,
    query,
    topK: 3,
  });

  console.log("\n📋 Top 3 most similar documents:");
  results.forEach((result, index) => {
    console.log("=".repeat(50) + " Top result:");
    console.log(`\n${index + 1}. (Score: ${result.score})`);
    console.log(`   ${result.content}`);
    console.log("=".repeat(100));
    console.log();
  });

  // Cleanup: close and delete workspace
  await ragCloseWorkspace({ workspace, deleteOnClose: true });
  console.log(`\n🗑️  Deleted '${workspace}' workspace`);

  await unloadModel({ modelId });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
