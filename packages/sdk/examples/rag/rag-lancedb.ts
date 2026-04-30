import { embed, loadModel, unloadModel, GTE_LARGE_FP16 } from "@qvac/sdk";
import * as lancedb from "@lancedb/lancedb";
import * as a from "apache-arrow";

try {
  // Get query from command line or use default
  const query = process.argv[2] || "machine learning algorithms";

  console.log(`🔍 Query: "${query}"`);

  const db = await lancedb.connect(".rag-lancedb");
  const modelId = await loadModel({
    modelSrc: GTE_LARGE_FP16,
    modelType: "embeddings",
    onProgress: (progress) => {
      console.log(`Loading model... ${progress.percentage.toFixed(1)}%`);
    },
  });

  const samples = [
    {
      id: 1,
      text: "Machine learning is a subset of artificial intelligence that focuses on algorithms that can learn and make predictions from data without being explicitly programmed for every task.",
    },
    {
      id: 2,
      text: "Deep learning uses neural networks with multiple layers to process and learn from complex data patterns, enabling breakthroughs in image recognition and natural language processing.",
    },
    {
      id: 3,
      text: "Natural language processing combines computational linguistics with machine learning to help computers understand, interpret, and generate human language in a meaningful way.",
    },
    {
      id: 4,
      text: "Computer vision enables machines to interpret and understand visual information from the world, using techniques like image classification, object detection, and facial recognition.",
    },
    {
      id: 5,
      text: "Quantum computing leverages quantum mechanical phenomena to process information in fundamentally different ways than classical computers, potentially solving certain problems exponentially faster.",
    },
    {
      id: 6,
      text: "Blockchain technology creates decentralized, immutable ledgers that enable secure peer-to-peer transactions without requiring a central authority or intermediary.",
    },
    {
      id: 7,
      text: "Cloud computing delivers computing services over the internet, allowing users to access resources like storage, processing power, and applications on-demand from anywhere.",
    },
    {
      id: 8,
      text: "Cybersecurity protects digital systems, networks, and data from malicious attacks, unauthorized access, and various forms of cyber threats through multiple layers of defense.",
    },
  ];

  const schema = new a.Schema([
    new a.Field("id", new a.Int32()),
    new a.Field("text", new a.Utf8()),
    new a.Field(
      "vector",
      new a.FixedSizeList(1024, new a.Field("item", new a.Float32())),
    ),
  ]);

  // Create or recreate the table
  try {
    await db.dropTable("documents");
  } catch (e) {
    console.warn(`Table doesn't exist, no need to drop: ${String(e)}`);
  }

  const documentsTable = await db.createEmptyTable("documents", schema);

  console.log("📚 Embedding documents...");
  const documents = [];
  for (const sample of samples) {
    const { embedding } = await embed({ modelId, text: sample.text });
    const record = {
      id: sample.id,
      text: sample.text,
      vector: embedding,
    };
    documents.push(record);
  }

  await documentsTable.add(documents);

  console.log("🔎 Searching for similar documents...");
  const { embedding: queryEmbedding } = await embed({ modelId, text: query });
  const results = (await documentsTable
    .vectorSearch(queryEmbedding)
    .limit(1)
    .toArray()) as {
    id: string;
    text: string;
    vector: number[];
    _distance: number;
  }[];

  console.log("\n📋 Top 3 most similar documents:");
  results.forEach((result, index) => {
    console.log("=".repeat(50) + " Top result:");
    console.log(`\n${index + 1}. (Score: ${result._distance?.toFixed(4)})`);
    console.log(`   ${result.text}`);
    console.log("=".repeat(100));
    console.log();
  });

  await unloadModel({ modelId });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
