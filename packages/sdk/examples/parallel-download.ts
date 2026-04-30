import {
  LLAMA_3_2_1B_INST_Q4_0,
  WHISPER_TINY,
  VAD_SILERO_5_1_2,
  GTE_LARGE_FP16,
  downloadAsset,
  close,
} from "@qvac/sdk";

function now(): number {
  return Date.now();
}

const assets = [
  { name: "Llama 3.2 1B", src: LLAMA_3_2_1B_INST_Q4_0 },
  { name: "Whisper Tiny", src: WHISPER_TINY },
  { name: "VAD Silero", src: VAD_SILERO_5_1_2 },
  { name: "GTE Large FP16", src: GTE_LARGE_FP16 },
];

const timers: Record<
  string,
  { start: number; firstProgress?: number; end?: number }
> = {};

console.log(`\n=== Parallel Download (${assets.length} assets) ===\n`);
const wallStart = now();

try {
  const promises = assets.map((asset) => {
    timers[asset.name] = { start: now() };

    return downloadAsset({
      assetSrc: asset.src,
      onProgress: (progress) => {
        const t = timers[asset.name]!;
        if (t.firstProgress == null) {
          t.firstProgress = now();
          console.log(
            `[${asset.name}] first progress at ${((t.firstProgress - wallStart) / 1000).toFixed(1)}s — ${progress.percentage}%`,
          );
        }
        if (progress.percentage === 100 && t.end == null) {
          t.end = now();
          console.log(
            `[${asset.name}] done at ${((t.end - wallStart) / 1000).toFixed(1)}s`,
          );
        }
      },
    });
  });

  const results = await Promise.allSettled(promises);
  const wallEnd = now();

  console.log(`\n=== Results ===\n`);

  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i]!;
    const result = results[i]!;
    const t = timers[asset.name]!;

    const status = result.status === "fulfilled" ? "OK" : "FAILED";
    const reason = result.status === "rejected" ? ` — ${result.reason}` : "";
    const timeToFirst =
      t.firstProgress != null
        ? `${((t.firstProgress - t.start) / 1000).toFixed(1)}s`
        : "N/A";
    const total =
      t.end != null ? `${((t.end - t.start) / 1000).toFixed(1)}s` : "N/A";

    console.log(
      `${status} ${asset.name}: first-progress=${timeToFirst}, total=${total}${reason}`,
    );
  }

  console.log(`\nWall time: ${((wallEnd - wallStart) / 1000).toFixed(1)}s`);

  void close();
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
