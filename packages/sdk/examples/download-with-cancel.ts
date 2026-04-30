import {
  cancel,
  close,
  downloadAsset,
  LLAMA_3_2_1B_INST_Q4_0,
} from "@qvac/sdk";

console.log(`🚀 Starting download with pause/resume example`);
console.log(
  `\n💡 Press Ctrl+C to pause the download (it will resume on restart)\n`,
);

let modelId: string | undefined;
let cancelled = false;

try {
  // Download model with progress tracking and cancellation
  await downloadAsset({
    assetSrc: LLAMA_3_2_1B_INST_Q4_0,
    onProgress: (progress) => {
      const downloadedMB = (progress.downloaded / 1024 / 1024).toFixed(2);
      const totalMB = (progress.total / 1024 / 1024).toFixed(2);
      const percentage = progress.percentage.toFixed(1);

      console.log(
        `📊 Progress: ${percentage}% (${downloadedMB}MB / ${totalMB}MB)`,
      );

      // Example: Stops at 10% (or use Ctrl+C for manual stop)
      if (parseFloat(percentage) >= 10 && !cancelled) {
        console.log("\n🚫 Auto-cancelling at 10% for demo purposes...,");
        console.log(
          `📊 Progress: ${percentage}% (${downloadedMB}MB / ${totalMB}MB)`,
        );
        console.log(progress);
        cancelled = true;

        // Use the downloadKey to cancel
        if (progress.downloadKey) {
          void cancel({
            operation: "downloadAsset",
            downloadKey: progress.downloadKey,
            // clearCache: true, // Uncomment to delete partial file instead of resuming
          });
        }
      }
    },
  });

  console.log(`\n✅ Model downloaded successfully! Model ID: ${modelId}`);
  console.log("🎯 Download completed without interruption");
  void close();
} catch (error) {
  if (error instanceof Error && error.message.includes("cancelled")) {
    console.log("✅ Download was successfully cancelled");
    void close();
  } else {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}
