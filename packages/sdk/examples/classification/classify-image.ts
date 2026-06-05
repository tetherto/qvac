import fs from "fs";
import {
  startQVACProvider,
  stopQVACProvider,
  loadModel,
  classify,
  unloadModel,
} from "@qvac/sdk";

/**
 * Classify an image using the bundled MobileNetV3-Small model.
 *
 * The bundled model produces three classes: "food", "report", "other".
 * No modelSrc is needed — the model ships inside @qvac/classification-ggml.
 */
async function main() {
  await startQVACProvider({});

  const modelId = await loadModel({
    modelType: "ggml-classification",
  });

  const image = fs.readFileSync("image.jpg");
  const results = await classify({ modelId, image });

  console.log("Classification results:");
  for (const { label, confidence } of results) {
    console.log(`  ${label}: ${(confidence * 100).toFixed(1)}%`);
  }

  await unloadModel({ modelId });
  await stopQVACProvider();
}

main().catch(console.error);
