// example-chroma.ts
import { embed, loadModel, unloadModel, GTE_LARGE_FP16 } from "@qvac/sdk";
import { ChromaClient } from "chromadb";

// Setup instructions for ChromaDB server
const CHROMADB_SETUP_INSTRUCTIONS = `
🚀 To run this example, you need a ChromaDB server running locally.

Setup options:

1. Using Chroma CLI (recommended):
   pip install chromadb
   chroma run --host localhost --port 8000 --path ./my_chroma_data

2. Using Docker:
   docker pull chromadb/chroma
   docker run -p 8000:8000 chromadb/chroma

For more details, visit: https://docs.trychroma.com/docs/overview/getting-started?lang=typescript
`;

async function initializeChromaClient() {
  const client = new ChromaClient({ host: "localhost", port: 8000 });

  try {
    await client.heartbeat();
    console.log("✅ Connected to ChromaDB server");
    return client;
  } catch {
    console.error("❌ Failed to connect to ChromaDB server");
    console.error("Please ensure the server is running on localhost:8000");
    console.error(CHROMADB_SETUP_INSTRUCTIONS);
    process.exit(1);
  }
}

try {
  // Get query from command line or use default
  const query = process.argv[2] || "machine learning algorithms";
  console.log(`🔍 Query: "${query}"`);

  const client = await initializeChromaClient();

  const modelId = await loadModel({
    modelSrc: GTE_LARGE_FP16,
    modelType: "embeddings",
    onProgress: (p) =>
      console.log(`Loading model... ${Math.round(p.percentage)}%`),
  });

  // Sample corpus
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

  // (Re)create the collection
  const collectionName = "documents";
  try {
    await client.deleteCollection({ name: collectionName });
  } catch (e) {
    console.warn(`Collection didn't exist, no need to delete: ${String(e)}`);
  }
  const collection = await client.createCollection({
    name: collectionName,
    embeddingFunction: null,
  });

  // Embed and add documents (we're bringing our own embeddings)
  console.log("📚 Embedding documents...");
  const ids: string[] = [];
  const documents: string[] = [];
  const embeddings: number[][] = [];

  for (const s of samples) {
    ids.push(String(s.id));
    documents.push(s.text);
    embeddings.push((await embed({ modelId, text: s.text })).embedding);
  }

  await collection.add({
    ids,
    documents,
    embeddings,
  });

  console.log("🔎 Searching for similar documents...");
  const { embedding: queryEmbedding } = await embed({ modelId, text: query });

  // Query top 3 by vector similarity and include distances
  const res = await collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults: 3,
    include: ["documents", "distances"],
  });

  console.log("\n📋 Top 3 most similar documents:");
  const docs = res.documents?.[0] ?? [];
  const dists = res.distances?.[0] ?? [];
  for (let i = 0; i < docs.length; i++) {
    console.log("=".repeat(50) + " Top result:");
    console.log(`\n${i + 1}. (Score: ${dists[i]?.toFixed(4)})`);
    console.log(`   ${docs[i]}`);
    console.log("=".repeat(100));
    console.log();
  }

  await unloadModel({ modelId });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
