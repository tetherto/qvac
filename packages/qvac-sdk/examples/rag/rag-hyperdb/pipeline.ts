import {
  loadModel,
  unloadModel,
  embed,
  GTE_LARGE_FP16,
  ragChunk,
  ragSaveEmbeddings,
  ragSearch,
  ragCloseWorkspace,
  type RagEmbeddedDoc,
} from "@qvac/sdk";

try {
  // Get query from command line or use default
  const query = process.argv[2] || "machine learning algorithms";

  console.log("🔧 RAG Pipeline Example (Segregated Flow)\n");
  console.log(`🔍 Query: "${query}"`);
  const workspace = "pipeline-example";

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

  console.log("\n📝 Step 1: Chunking documents...");
  const chunks = await ragChunk({
    documents: samples,
    chunkOpts: {
      chunkSize: 128,
      chunkOverlap: 20,
    },
  });
  console.log(`   Created ${chunks.length} chunks`);

  console.log("\n🧠 Step 2: Generating embeddings (batch)...");
  const texts = chunks.map((chunk) => chunk.content);
  const embeddings = await embed({ modelId, text: texts });

  const embeddedDocs = chunks.map((chunk, i) => ({
    id: chunk.id,
    content: chunk.content,
    embedding: embeddings[i],
    embeddingModelId: modelId,
  })) as RagEmbeddedDoc[];
  console.log(`   Generated ${embeddedDocs.length} embeddings`);

  console.log("\n💾 Step 3: Saving to vector database...");
  const saveResult = await ragSaveEmbeddings({
    workspace,
    documents: embeddedDocs,
  });
  const saved = saveResult.filter((r) => r.status === "fulfilled").length;
  console.log(`   Saved ${saved}/${saveResult.length} documents`);

  console.log("\n🔎 Step 4: Searching...");
  const results = await ragSearch({
    workspace,
    modelId,
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
  console.log(`🗑️  Deleted '${workspace}' workspace`);

  await unloadModel({ modelId });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
