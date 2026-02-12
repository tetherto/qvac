// Set config path before importing SDK - the SDK loads config during initialization
// This example uses a config file that defines blind relay public keys for improved P2P connectivity
// Blind relays help establish connections through NAT/firewalls by acting as intermediaries

const configDir = import.meta.dirname ?? process.cwd();
process.env["QVAC_CONFIG_PATH"] =
  `${configDir}/config/blind-relay/blind-relay.config.js`;

import {
  downloadAsset,
  close,
  LLAMA_3_2_1B_INST_Q4_0,
  type ModelProgressUpdate,
  loadModel,
  getModelInfo,
  unloadModel,
} from "@qvac/sdk";

console.log(`🚀 Download with Blind Relays Example`);
console.log(`${"=".repeat(60)}\n`);

try {
  // Config is loaded from examples/config/qvac.config.json (set via QVAC_CONFIG_PATH above)
  // The config contains swarmRelays - an array of Hyperswarm relay public keys
  // These relays help with NAT traversal and firewall bypassing for P2P downloads

  console.log(`📥 Starting model download from Hyperdrive...\n`);

  const startTime = Date.now();

  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelType: "llm",
  });

  console.log(`Model loaded with ID: ${modelId}`);

  const firstStatus = await getModelInfo(LLAMA_3_2_1B_INST_Q4_0);

  console.log(`First status: ${JSON.stringify(firstStatus)}`);

  await unloadModel({ modelId });

  // Download model with progress tracking
  await downloadAsset({
    assetSrc: LLAMA_3_2_1B_INST_Q4_0,
    onProgress: (progress: ModelProgressUpdate) => {
      const downloadedMB = (progress.downloaded / 1024 / 1024).toFixed(2);
      const totalMB = (progress.total / 1024 / 1024).toFixed(2);
      const percentage = progress.percentage.toFixed(1);
      const elapsedSeconds = (Date.now() - startTime) / 1000;
      const speedMBps = (
        progress.downloaded /
        1024 /
        1024 /
        elapsedSeconds
      ).toFixed(2);

      console.log(
        `📊 ${percentage}% - ${downloadedMB}MB / ${totalMB}MB (${speedMBps} MB/s)`,
      );
    },
  });

  console.log(`\n✅ Model downloaded successfully using blind relays!`);
  console.log(
    `Blind relays helped establish peer connections through NAT/firewalls\n`,
  );

  close();
} catch (error) {
  console.error("❌ Error:", error);
  console.log(`\nIf download failed, check the relay public keys in:`);
  console.log(`   examples/config/qvac.config.json`);
  console.log(`   (Mock keys in this example won't work in practice!)`);
  process.exit(1);
}
