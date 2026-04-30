import { LLAMA_3_2_1B_INST_Q4_0, downloadAsset } from "@qvac/sdk";

await downloadAsset({
  assetSrc: LLAMA_3_2_1B_INST_Q4_0,
  seed: true,
  onProgress: (progress) => {
    console.log(progress);
  },
})
  .then(() => {
    console.log("✅ Model loaded and seeding started!");
    console.log("📡 Seeding service is running... Press Ctrl+C to stop");
  })
  .catch((error) => {
    console.error("❌ Error:", error);
    process.exit(1);
  });

process.on("SIGINT", () => {
  console.log("\n🛑 Seeding service stopped");
  process.exit(0);
});

process.stdin.resume();
