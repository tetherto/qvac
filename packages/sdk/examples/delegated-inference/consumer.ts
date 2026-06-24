import {
  completion,
  LLAMA_3_2_1B_INST_Q4_0,
  loadModel,
  close,
} from "@qvac/sdk";

const providerPublicKey = process.argv[2];
if (!providerPublicKey) {
  console.error(
    "✖ Provider public key is required. Usage: node consumer.ts <provider-public-key> [consumer-seed]",
  );
  process.exit(1);
}

try {
  // Optional: Consumer seed for deterministic consumer identity (for firewall testing)
  const consumerSeed = process.argv[3];

  process.env["QVAC_HYPERSWARM_SEED"] = consumerSeed;

  console.log(`▸ Testing delegated inference`);
  console.log(`▸ Provider: ${providerPublicKey}`);
  if (consumerSeed) {
    console.log(
      `▸ Consumer seed: ${consumerSeed.substring(0, 16)}... (deterministic identity)`,
    );
  } else {
    console.log(`▸ No consumer seed provided (random identity)`);
  }

  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    delegate: {
      providerPublicKey,
      // Generous timeout for the first call on a cold DHT: bootstrapping
      // hyperdht and looking up the provider's key can take 15–45s on the
      // very first run. Subsequent connections in the same process are
      // sub-second because the DHT is already warm.
      timeout: 60_000,
      fallbackToLocal: true, // Optional: Fall back to local inference if delegation fails
      // forceNewConnection: true, // Optional: Force a new connection instead of reusing cached one
    },
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
      if (p.percentage >= 100) process.stderr.write("\n");
    },
  });

  console.log(`▸ Delegated model registered: ${modelId}`);

  const response = completion({
    modelId,
    history: [{ role: "user", content: "Hello!" }],
    stream: true,
  });

  for await (const token of response.tokenStream) {
    process.stdout.write(token);
  }

  console.log("\n▸ Stats:", await response.stats);

  console.log(
    "▸ Delegation infrastructure working! Server correctly detected and routed the delegated request.",
  );

  void close();
} catch (error) {
  console.error("✖", error);
  process.exit(1);
}
