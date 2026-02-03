import {
  close,
  loadModel,
  ocr,
  OCR_CRAFT_LATIN_RECOGNIZER_1,
  unloadModel,
} from "@qvac/sdk";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imagePath =
  process.argv[2] || path.join(__dirname, "image/basic_test.bmp");

try {
  console.log("🚀 Loading OCR model...");
  // Only need to pass the recognizer - detector is auto-derived from same hyperdrive key
  const modelId = await loadModel({
    modelSrc: OCR_CRAFT_LATIN_RECOGNIZER_1,
    modelType: "ocr",
    modelConfig: {
      langList: ["en"],
      useGPU: true,
      timeout: 30000,
      magRatio: 1.5,
      defaultRotationAngles: [90, 180, 270],
      contrastRetry: false,
      lowConfidenceThreshold: 0.5,
      recognizerBatchSize: 1,
    },
  });
  console.log(`✅ Model loaded successfully! Model ID: ${modelId}`);

  console.log(`\n🔍 Running OCR on: ${imagePath}`);
  const { blocks } = ocr({
    modelId,
    image: imagePath,
    options: {
      paragraph: false,
    },
  });

  const result = await blocks;

  console.log("\n📝 OCR Results:");
  console.log("================================");
  for (const block of result) {
    console.log(`\n📄 Text: ${block.text}`);
    if (block.bbox) {
      console.log(`   📍 BBox: [${block.bbox.join(", ")}]`);
    }
    if (block.confidence !== undefined) {
      console.log(`   ✓ Confidence: ${block.confidence}`);
    }
  }
  console.log("\n================================");
  console.log("\n🔄 Unloading model...");
  await unloadModel({ modelId, clearStorage: false });
  console.log("✅ Model unloaded successfully.");
} catch (error) {
  console.error("❌ Error during OCR processing:", error);
  close();
}
