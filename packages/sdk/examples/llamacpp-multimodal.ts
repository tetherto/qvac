import {
  completion,
  loadModel,
  SMOLVLM2_2_500M_MULTIMODAL_Q8_0,
  MMPROJ_SMOLVLM2_2_500M_MULTIMODAL_Q8_0,
  unloadModel,
} from "@qvac/sdk";

if (process.argv.length < 3) {
  console.error(
    `Specify an image file path as the first argument and a second image file path as the second (optional) argument`,
  );
  process.exit(1);
}

try {
  // const modelPath = args[modelIndex + 1]!;
  const imageFilePath = process.argv[2]!;

  // Load the main model with projection in a single step
  const modelId = await loadModel({
    modelSrc: SMOLVLM2_2_500M_MULTIMODAL_Q8_0,
    modelType: "llm",
    projectionModelSrc: MMPROJ_SMOLVLM2_2_500M_MULTIMODAL_Q8_0,
    modelConfig: {
      ctx_size: 1024,
    },
    onProgress: (progress) => {
      console.log(`Loading: ${progress.percentage.toFixed(1)}%`);
    },
  });

  //Using one particular media
  const history = [
    {
      role: "user",
      content: "What's in this image?",
      attachments: [{ path: imageFilePath }],
    },
  ];
  const result = completion({ modelId, history, stream: true });

  for await (const token of result.tokenStream) {
    process.stdout.write(token);
  }

  const stats = await result.stats;

  console.log("\n📊 Performance Stats:", stats);

  console.log("--------------------------------");

  //Using multiple media
  if (process.argv.length < 4) {
    console.log(`Only one image provided, terminating`);
    process.exit(0);
  }

  const imageFilePath2 = process.argv[3]!;

  const history2 = [
    {
      role: "user",
      content: "Compare the two newspaper articles",
      attachments: [{ path: imageFilePath }, { path: imageFilePath2 }],
    },
  ];

  const result2 = completion({ modelId, history: history2, stream: true });

  for await (const token of result2.tokenStream) {
    process.stdout.write(token);
  }

  const stats2 = await result2.stats;

  console.log("\n📊 Performance Stats:", stats2);

  console.log("--------------------------------");

  await unloadModel({ modelId, clearStorage: false });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
