import { embed, loadModel, unloadModel, GTE_LARGE_FP16 } from "@qvac/sdk";
import sqlite3InitModule from "@sqliteai/sqlite-wasm";

try {
  // Get query from command line or use default
  const query = process.argv[2] || "machine learning algorithms";
  console.log(`🔍 Query: "${query}"`);

  // Initialize SQLite with vector extension
  const sqlite3 = await sqlite3InitModule();
  const db = new sqlite3.oo1.DB(":memory:", "c");

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

  // Create table for documents with vector storage
  db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY,
    text TEXT NOT NULL,
    embedding BLOB NOT NULL
  )
`);

  console.log("📚 Embedding documents...");
  for (const sample of samples) {
    const { embedding } = await embed({ modelId, text: sample.text });
    db.exec({
      sql: "INSERT INTO documents VALUES (?, ?, vector_as_f32(?))",
      bind: [sample.id, sample.text, JSON.stringify(embedding)],
    });
  }

  // Initialize and optimize vector index
  db.exec(
    `SELECT vector_init('documents', 'embedding', 'type=FLOAT32,dimension=1024')`,
  );

  // Quantize vectors
  db.exec(`SELECT vector_quantize('documents', 'embedding')`);

  // [Optional] Preload quantized vectors in memory for optimal performance
  db.exec(`SELECT vector_quantize_preload('documents', 'embedding')`);

  // Search for similar documents
  console.log("🔎 Searching for similar documents...");
  const { embedding: queryEmbedding } = await embed({ modelId, text: query });

  const results: Array<{
    id: number;
    text: string;
    distance: number;
  }> = [];

  // Perform vector search
  db.exec({
    sql: `
    SELECT d.id, d.text, v.distance 
    FROM documents d
    JOIN vector_quantize_scan('documents', 'embedding', vector_as_f32(?), 3) v
    ON d.id = v.rowid
  `,
    bind: [JSON.stringify(queryEmbedding)],
    rowMode: "object",
    callback: (row: unknown) => {
      const typedRow = row as { id: number; text: string; distance: number };
      results.push(typedRow);
    },
  });

  console.log("\n📋 Top 3 most similar documents:");
  results.forEach((result, index) => {
    console.log("=".repeat(50) + " Top result:");
    console.log(
      `\n${index + 1}. [ID: ${result.id}] (Score: ${result.distance.toFixed(4)})`,
    );
    console.log(`   ${result.text}`);
    console.log("=".repeat(100));
    console.log();
  });

  await unloadModel({ modelId });
  db.close();
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
