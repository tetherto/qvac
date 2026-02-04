import {
  loadModel,
  unloadModel,
  GTE_LARGE_FP16,
  ragIngest,
  ragSearch,
  ragDeleteEmbeddings,
  ragListWorkspaces,
  ragCloseWorkspace,
  ragReindex,
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

  // Medical articles (will be chunked)
  const medicalArticles = [
    `COVID-19: A Comprehensive Overview
    
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
    medications such as remdesivir or Paxlovid.`,

    `Diabetes Management and Prevention
    
    Diabetes is a chronic condition affecting how your body processes blood sugar. Type 1 diabetes 
    occurs when the immune system attacks insulin-producing cells. Type 2 diabetes develops when 
    the body becomes resistant to insulin or doesn't produce enough.
    
    Prevention strategies for Type 2 diabetes include maintaining a healthy weight, regular physical 
    activity, and a balanced diet rich in whole grains, vegetables, and lean proteins. Regular 
    monitoring of blood glucose levels is essential for managing the condition.
    
    Treatment may include lifestyle modifications, oral medications, and insulin therapy. Complications 
    can affect the heart, kidneys, eyes, and nervous system if blood sugar is not well controlled.`,

    `Heart Disease: Risk Factors and Prevention
    
    Cardiovascular disease remains the leading cause of death worldwide. Risk factors include high 
    blood pressure, high cholesterol, smoking, obesity, diabetes, and physical inactivity.
    
    Prevention involves adopting a heart-healthy lifestyle: regular exercise, a diet low in saturated 
    fats and sodium, maintaining a healthy weight, and avoiding tobacco. Regular check-ups can help 
    detect problems early.
    
    Treatment options range from lifestyle changes and medications to surgical interventions like 
    angioplasty, stent placement, or bypass surgery depending on severity.`,

    `Mental Health and Wellness
    
    Mental health encompasses emotional, psychological, and social well-being. Common conditions 
    include anxiety disorders, depression, bipolar disorder, and schizophrenia. These affect 
    thinking, mood, and behavior.
    
    Treatment typically involves a combination of psychotherapy, medication, and lifestyle changes. 
    Cognitive behavioral therapy has proven effective for many conditions. Support systems and 
    stress management techniques are crucial components of recovery.
    
    Early intervention improves outcomes significantly. Reducing stigma around mental health 
    encourages people to seek help when needed.`,
  ];

  // Tech documents (shorter, won't be chunked)
  const techDocs = [
    "Artificial intelligence is transforming industries through automation and advanced data analysis capabilities.",
    "Deep learning neural networks enable breakthroughs in computer vision and natural language processing.",
  ];

  // Ingest medical articles with chunking
  console.log("📚 Ingesting medical articles with chunking...");
  const medicalResult = await ragIngest({
    modelId,
    workspace: "medical",
    documents: medicalArticles,
    chunk: true,
    chunkOpts: {
      chunkSize: 50,
      chunkOverlap: 10,
      chunkStrategy: "paragraph",
      splitStrategy: "token",
    },
  });
  console.log(
    `✅ Created ${medicalResult.processed.length} chunks from medical articles`,
  );

  // Ingest tech docs without chunking
  console.log("\n📚 Ingesting tech documents...");
  const techResult = await ragIngest({
    modelId,
    workspace: "technology",
    documents: techDocs,
    chunk: false,
  });
  console.log(`✅ Ingested ${techResult.processed.length} tech documents`);

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

  // Test a third workspace
  console.log("\n📁 Testing 'general' workspace...");
  await ragIngest({
    modelId,
    workspace: "general",
    documents: ["General workspace content for testing"],
    chunk: false,
  });

  const generalSearch = await ragSearch({
    modelId,
    workspace: "general",
    query: "general workspace",
  });
  console.log(
    `General workspace: ${generalSearch?.[0]?.content === "General workspace content for testing" ? "✅ Working" : "❌ Failed"}`,
  );

  // Reindexing - regenerate embeddings for an existing workspace
  console.log("\n🔄 Reindexing medical workspace...");
  const reindexResult = await ragReindex({
    workspace: "medical",
    modelId,
    onProgress: (stage, current, total) => {
      const pct = total > 0 ? Math.round((current / total) * 100) : 0;
      console.log(`   [${stage}] ${current}/${total} (${pct}%)`);
    },
  });
  console.log(
    `${reindexResult.reindexed ? "✅ Reindex completed" : "⚠️  Reindex returned false"} for medical workspace`,
  );
  if (reindexResult.details) {
    console.log("   Details:", reindexResult.details);
  }

  // Verify reindexed data still works
  const reindexVerify = await ragSearch({
    modelId,
    workspace: "medical",
    query: "COVID symptoms",
    topK: 1,
  });
  console.log(
    `   Verification search: ${reindexVerify.length > 0 ? "✅ Working" : "❌ Failed"}`,
  );

  // Cleanup example
  const firstChunk = medicalResult.processed.find(
    (p) => p.status === "fulfilled" && p.id,
  );
  if (firstChunk?.id) {
    await ragDeleteEmbeddings({
      workspace: "medical",
      ids: [firstChunk.id],
    });
    console.log("\n🗑️  Deleted one medical chunk");
  }

  // List all workspaces
  console.log("\n📂 Listing workspaces...");
  const workspaces = await ragListWorkspaces();
  workspaces.forEach((ws) => {
    console.log(`  • ${ws.name} (${ws.open ? "open" : "closed"})`);
  });

  // Close and delete all workspaces created in this example
  console.log("\n🗑️  Closing and deleting workspaces...");
  await ragCloseWorkspace({ workspace: "medical", deleteOnClose: true });
  console.log("Deleted 'medical' workspace");
  await ragCloseWorkspace({ workspace: "technology", deleteOnClose: true });
  console.log("Deleted 'technology' workspace");
  await ragCloseWorkspace({ workspace: "general", deleteOnClose: true });
  console.log("Deleted 'general' workspace");

  await unloadModel({ modelId });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
