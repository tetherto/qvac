/**
 * OCR example using the QVAC SDK.
 *
 * Usage:
 *   bun examples/ocr-fasttext.ts [path-to-image]
 *
 * This example requires a test image (default: examples/image/basic_test.bmp).
 * Sample images are available in the QVAC source repository, but not included in the published npm package.
 * Pass a custom image path, or download the default image into examples/image/:
 *   https://github.com/tetherto/qvac/blob/main/packages/sdk/examples/image/basic_test.bmp
 */
import {
  close,
  loadModel,
  ocr,
  OCR_LATIN_RECOGNIZER_1,
  unloadModel,
} from "@qvac/sdk";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imagePath =
  process.argv[2] || path.join(__dirname, "image/basic_test.bmp");

try {
  console.log("🚀 Loading OCR model...");
  const modelId = await loadModel({
    modelSrc: OCR_LATIN_RECOGNIZER_1,
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
  process.exit(0);
} catch (error) {
  console.error("❌ Error during OCR processing:", error);
  await close();
}
