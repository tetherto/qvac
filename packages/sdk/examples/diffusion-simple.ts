import { loadModel, unloadModel, diffusion, SD_V2_1_1B_Q8_0 } from "@qvac/sdk";
import fs from "fs";

// Minimal diffusion example — single GGUF model, no companion files needed.
// Works with SD 1.x / 2.x all-in-one models.
const modelSrc = process.argv[2] || SD_V2_1_1B_Q8_0;
const prompt = process.argv[3] || "a photo of a cat sitting on a windowsill";

const modelId = await loadModel({
  modelSrc,
  modelType: "diffusion",
  modelConfig: { prediction: "v" },
});

const { outputs } = diffusion({ modelId, prompt });
const buffers = await outputs;

fs.writeFileSync("output.png", buffers[0]!);
console.log("Saved: output.png");

await unloadModel({ modelId, clearStorage: false });
process.exit(0);
