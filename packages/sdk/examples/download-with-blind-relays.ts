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

console.log(`▸ Download with Blind Relays Example`);
console.log(`${"=".repeat(60)}\n`);

try {
  // Config is loaded from examples/config/qvac.config.json (set via QVAC_CONFIG_PATH above)
  // The config contains swarmRelays - an array of Hyperswarm relay public keys
  // These relays help with NAT traversal and firewall bypassing for P2P downloads

  console.log(`▸ Starting model download from Hyperdrive...\n`);

  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
  });

  console.log(`▸ Model loaded with ID: ${modelId}`);

  const firstStatus = await getModelInfo(LLAMA_3_2_1B_INST_Q4_0);

  console.log(`▸ First status: ${JSON.stringify(firstStatus)}`);

  await unloadModel({ modelId });

  // Download model with progress tracking
  await downloadAsset({
    assetSrc: LLAMA_3_2_1B_INST_Q4_0,
    onProgress: (p: ModelProgressUpdate) => {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
      if (p.percentage >= 100) process.stderr.write("\n");
    },
  });

  console.log(`\n▸ Model downloaded successfully using blind relays!`);
  console.log(
    `▸ Blind relays helped establish peer connections through NAT/firewalls\n`,
  );

  await close();
} catch (error) {
  console.error("✖", error);
  console.log(`\n▸ If download failed, check the relay public keys in:`);
  console.log(`▸ examples/config/qvac.config.json`);
  console.log(`▸ (Mock keys in this example won't work in practice!)`);
  process.exit(1);
}
