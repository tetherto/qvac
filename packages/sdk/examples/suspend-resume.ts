import {
  loadModel,
  LLAMA_3_2_1B_INST_Q4_0,
  completion,
  unloadModel,
  suspend,
  resume,
  state,
} from "@qvac/sdk";

try {
  // Load a model
  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelType: "llm",
    onProgress: (progress) => {
      console.log(progress);
    },
  });

  console.log("✅ Model loaded\n");

  console.log(`📊 Lifecycle state: ${await state()}\n`);

  // Run a completion before suspending
  console.log("--- Completion before suspend ---");
  const result1 = completion({
    modelId,
    history: [{ role: "user", content: "Say hello in one word" }],
    stream: true,
  });
  for await (const token of result1.tokenStream) {
    process.stdout.write(token);
  }
  console.log("\n");

  // Suspend all networking and storage (e.g. app going to background)
  console.log("⏸️  Suspending...");
  await suspend();
  console.log(`📊 Lifecycle state: ${await state()}\n`);

  try {
    await completion({
      modelId,
      history: [{ role: "user", content: "This should fail" }],
      stream: false,
    }).text;
  } catch (error: unknown) {
    const name = (error as { name?: string }).name;
    if (name === "LIFECYCLE_OPERATION_BLOCKED") {
      console.log(`🚫 Operation blocked while suspended (${name})`);
    } else {
      throw error;
    }
  }

  // Simulate time in background
  console.log("\n💤 Simulating 3 seconds in background...");
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Resume when returning to foreground
  console.log("▶️  Resuming...");
  await resume();
  console.log(`📊 Lifecycle state: ${await state()}\n`);

  // Run another completion after resuming
  console.log("--- Completion after resume ---");
  const result2 = completion({
    modelId,
    history: [{ role: "user", content: "Say goodbye in one word" }],
    stream: true,
  });
  for await (const token of result2.tokenStream) {
    process.stdout.write(token);
  }
  console.log("\n");

  await unloadModel({ modelId });
  console.log("✅ Model unloaded");
  process.exit(0);
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
