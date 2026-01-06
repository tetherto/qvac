import {
  loadModel,
  unloadModel,
  GTE_LARGE_FP16,
  ragSaveEmbeddings,
  ragSearch,
  ragDeleteEmbeddings,
} from "@qvac/sdk";

try {
  console.log("🚀 RAG Workspaces with Chunking Example\n");

  // Load model
  const modelId = await loadModel({
    modelSrc: GTE_LARGE_FP16,
    modelType: "embeddings",
    onProgress: (p) =>
      process.stdout.write(`\rLoading: ${Math.round(p.percentage * 100)}%`),
  });
  console.log("\n");

  // Medical article (will be chunked)
  const medicalArticle = `
    COVID-19: A Comprehensive Overview
    
    COVID-19 is a respiratory illness caused by the SARS-CoV-2 virus, first identified in December 2019 
    in Wuhan, China. The virus spreads primarily through respiratory droplets when an infected person 
    coughs, sneezes, or talks.
    
    Common symptoms include fever, cough, fatigue, and loss of taste or smell. Some patients may 
    experience shortness of breath, muscle aches, sore throat, and headaches. Symptoms typically 
    appear 2-14 days after exposure to the virus.
    
    Vaccines have been developed using various technologies including mRNA, viral vector, and 
    inactivated virus approaches. These vaccines have proven effective in preventing severe illness, 
    hospitalization, and death. Booster doses are recommended to maintain immunity.
    
    Treatment options vary based on severity. Mild cases often require only supportive care including 
    rest and hydration. Severe cases may require hospitalization, oxygen therapy, and antiviral 
    medications such as remdesivir or Paxlovid.
  `;

  // Tech documents (shorter, won't be chunked)
  const techDocs = [
    "Artificial intelligence is transforming industries through automation and advanced data analysis capabilities.",
    "Deep learning neural networks enable breakthroughs in computer vision and natural language processing.",
  ];

  // Save medical article with chunking
  console.log("📚 Saving medical article with chunking...");
  const medicalResult = await ragSaveEmbeddings({
    modelId,
    workspace: "medical",
    documents: medicalArticle,
    chunk: true,
    chunkOpts: {
      chunkSize: 100,
      chunkOverlap: 10,
      chunkStrategy: "paragraph",
      splitStrategy: "token",
    },
  });
  console.log(
    `✅ Created ${medicalResult.processed.length} chunks from medical article`,
  );

  // Save tech docs without chunking
  console.log("\n📚 Saving tech documents...");
  const techResult = await ragSaveEmbeddings({
    modelId,
    workspace: "technology",
    documents: techDocs,
    chunk: false,
  });
  console.log(`✅ Saved ${techResult.processed.length} tech documents`);

  // Test searches
  const searches = [
    { workspace: "medical", query: "COVID symptoms fever", label: "Medical" },
    { workspace: "medical", query: "vaccine technology", label: "Medical" },
    { workspace: "technology", query: "neural networks", label: "Tech" },
    { workspace: "technology", query: "COVID", label: "Tech (isolation test)" },
  ];

  console.log("\n🔍 Running searches:");
  for (const { workspace, query, label } of searches) {
    const results = await ragSearch({ modelId, workspace, query, topK: 1 });
    console.log(`\n${label}: "${query}"`);
    if (results.length > 0 && results[0]) {
      console.log(`  ✓ Score: ${results[0].score.toFixed(3)}`);
      console.log(`  ✓ Match: ${results[0].content.substring(0, 80)}...`);
    } else {
      console.log(`  ✗ No results (workspace isolation working correctly)`);
    }
  }

  // Test default workspace
  console.log("\n📁 Testing default workspace...");
  await ragSaveEmbeddings({
    modelId,
    documents: ["Default workspace content for testing"],
    chunk: false,
  });

  const defaultSearch = await ragSearch({
    modelId,
    query: "default workspace",
  });
  console.log(
    `Default workspace: ${defaultSearch?.[0]?.content === "Default workspace content for testing" ? "✅ Working" : "❌ Failed"}`,
  );

  // Cleanup example
  const firstChunk = medicalResult.processed.find(
    (p) => p.status === "fulfilled" && p.id,
  );
  if (firstChunk?.id) {
    await ragDeleteEmbeddings({
      modelId,
      workspace: "medical",
      ids: [firstChunk.id],
    });
    console.log("\n🗑️  Deleted one medical chunk");
  }

  await unloadModel({ modelId });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
