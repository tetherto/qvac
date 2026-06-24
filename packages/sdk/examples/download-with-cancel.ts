import {
  cancel,
  close,
  downloadAsset,
  LLAMA_3_2_1B_INST_Q4_0,
} from "@qvac/sdk";

console.log(`▸ Starting download with pause/resume example`);
console.log(
  `\n▸ Press Ctrl+C to pause the download (it will resume on restart)\n`,
);

let modelId: string | undefined;
let cancelled = false;

try {
  // Download model with progress tracking and cancellation. The
  // `downloadAsset(...)` call returns a *decorated* promise: the
  // promise resolves to the modelId, and the same value carries a
  // synchronous `requestId` field so we can cancel before it settles.
  const download = downloadAsset({
    assetSrc: LLAMA_3_2_1B_INST_Q4_0,
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
      if (p.percentage >= 100) process.stderr.write("\n");

      // Example: Stops at 10% (or use Ctrl+C for manual stop)
      if (p.percentage >= 10 && !cancelled) {
        console.log("\n▸ Auto-cancelling at 10% for demo purposes...");
        cancelled = true;

        void cancel({
          requestId: download.requestId,
          // clearCache: true, // Uncomment to delete partial file instead of resuming
        });
      }
    },
  });
  modelId = await download;

  console.log(`\n▸ Model downloaded successfully! Model ID: ${modelId}`);
  console.log("▸ Download completed without interruption");
  void close();
} catch (error) {
  if (error instanceof Error && error.message.includes("cancelled")) {
    console.log("▸ Download was successfully cancelled");
    void close();
  } else {
    console.error("✖", error);
    process.exit(1);
  }
}
