import {
  LLAMA_3_2_1B_INST_Q4_0,
  downloadAsset,
  WHISPER_LARGE_3,
  close,
} from "@qvac/sdk";

try {
  const llamaDownloadPromise = downloadAsset({
    assetSrc: LLAMA_3_2_1B_INST_Q4_0,
    onProgress: (progress) => {
      console.log("💬 Llama progress:", progress);
    },
  });

  const whisperDownloadPromise = downloadAsset({
    assetSrc: WHISPER_LARGE_3,
    onProgress: (progress) => {
      console.log("🔊 Whisper progress:", progress);
    },
  });

  await Promise.all([llamaDownloadPromise, whisperDownloadPromise]);

  void close();
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
