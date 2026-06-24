import { LLAMA_3_2_1B_INST_Q4_0, downloadAsset } from "@qvac/sdk";

await downloadAsset({
  assetSrc: LLAMA_3_2_1B_INST_Q4_0,
  seed: true,
  onProgress: (p) => {
    const mb = (n: number) => (n / 1e6).toFixed(1);
    const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
    process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
    if (p.percentage >= 100) process.stderr.write("\n");
  },
})
  .then(() => {
    console.log("▸ Model loaded and seeding started!");
    console.log("▸ Seeding service is running... Press Ctrl+C to stop");
  })
  .catch((error) => {
    console.error("✖", error);
    process.exit(1);
  });

process.on("SIGINT", () => {
  console.log("\n▸ Seeding service stopped");
  process.exit(0);
});

process.stdin.resume();
