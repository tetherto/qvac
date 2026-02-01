import {
  completion,
  LLAMA_3_2_1B_INST_Q4_0,
  loadModel,
  QWEN_3_1_7B_INST_Q4,
  unloadModel,
} from "@qvac/sdk";

try {
  const alice = await loadModel({
    modelSrc: QWEN_3_1_7B_INST_Q4,
    modelType: "llm",
    modelConfig: {
      ctx_size: 4096,
    },
  });
  const bob = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelType: "llm",
    modelConfig: {
      ctx_size: 4096,
    },
    onProgress: (progress) =>
      console.log(`Loading Bob: ${progress.percentage.toFixed(1)}%`),
  });

  const aliceHistory = [
    {
      role: "system",
      content: "You answer questions about.",
    },
    { role: "user", content: "What is Bitcoin?" },
  ];
  const bobHistory = [
    {
      role: "system",
      content: "You ask questions about Bitcoin in one sentence.",
    },
  ];

  console.log("🙋🏻‍♂️ Bob: ", "What is Bitcoin?");

  const aliceResponse = completion({
    modelId: alice,
    history: [...aliceHistory],
    stream: false,
  });
  const aliceText = await aliceResponse.text;
  aliceHistory.push({ role: "assistant", content: aliceText });

  console.log("🙋🏻‍♀️ Alice: ", aliceText);
  console.log("📊 Alice Stats: ", await aliceResponse.stats);

  const bobResponse = completion({
    modelId: bob,
    history: [...bobHistory, { role: "user", content: aliceText }],
    stream: false,
  });
  const bobText = await bobResponse.text;
  bobHistory.push({ role: "assistant", content: bobText });

  console.log("🙋🏻‍♂️ Bob: ", bobText);
  console.log("📊 Bob Stats: ", await bobResponse.stats);

  const aliceResponse2 = completion({
    modelId: alice,
    history: [...aliceHistory, { role: "user", content: bobText }],
    stream: false,
  });
  const aliceText2 = await aliceResponse2.text;
  aliceHistory.push({ role: "assistant", content: aliceText2 });

  console.log("🙋🏻‍♀️ Alice: ", aliceText2);
  console.log("📊 Alice Stats: ", await aliceResponse2.stats);

  const bobResponse2 = completion({
    modelId: bob,
    history: [...bobHistory, { role: "user", content: aliceText2 }],
    stream: false,
  });
  const bobText2 = await bobResponse2.text;
  bobHistory.push({ role: "assistant", content: bobText2 });

  console.log("🙋🏻‍♂️ Bob: ", bobText2);
  console.log("📊 Bob Stats: ", await bobResponse2.stats);

  await unloadModel({ modelId: alice, clearStorage: false });
  await unloadModel({ modelId: bob, clearStorage: false });
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
