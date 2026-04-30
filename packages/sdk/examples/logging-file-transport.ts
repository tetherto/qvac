import {
  getLogger,
  loadModel,
  completion,
  unloadModel,
  LLAMA_3_2_1B_INST_Q4_0,
  VERBOSITY,
} from "@qvac/sdk";
import { writeFileSync, appendFileSync } from "fs";
import { join } from "path";

try {
  const logFile = join(process.cwd(), "model-logs.txt");

  // Clear previous logs
  writeFileSync(logFile, "");

  // Create logger with file transport
  const logger = getLogger("llm-file-demo", {
    level: "debug",
    enableConsole: false, // Disable console output (logs go to file only). Set to true for both console + file
    transports: [
      // File transport - append logs to file
      (level, namespace, message) => {
        const timestamp = new Date().toISOString();
        const logLine = `[${timestamp}] ${level.toUpperCase()} ${namespace}: ${message}\n`;
        appendFileSync(logFile, logLine);
      },
    ],
  });

  logger.info("Starting model demo with file logging");

  // Load model with integrated logging
  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelType: "llm",
    modelConfig: {
      ctx_size: 2048,
      temp: 0.7,
      verbosity: VERBOSITY.DEBUG,
    },
    logger, // All model logs will be captured
  });

  logger.info(`Model loaded: ${modelId}`);

  // Run a simple completion
  logger.info("Starting completion...");

  const messages = [
    { role: "user", content: "Tell me a short joke about programming." },
  ];

  let responseText = "";

  const result = completion({ modelId, history: messages, stream: true });

  for await (const token of result.tokenStream) {
    responseText += token;
    process.stdout.write(token);
  }

  console.log("\n");
  logger.info(
    `Completion finished, ${responseText.length} characters generated`,
  );

  // Unload model
  await unloadModel({ modelId });
  logger.info("Model unloaded successfully");

  // Show user where logs were saved
  console.log(`\n📄 All logs (including model internals) saved to: ${logFile}`);
  console.log("You can inspect the file to see detailed model operation logs!");
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
