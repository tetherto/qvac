import { startQVACProvider } from "@qvac/sdk";

// Random topic if not provided
const topic =
  process.argv[2] ||
  "66646f696865726f6569686a726530776a66646f696865726f6569686a726530";

// Optional: Seed for deterministic provider identity (64-character hex string)
const seed: string | undefined = process.argv[3];

process.env["QVAC_HYPERSWARM_SEED"] = seed;

// Optional: Consumer public key for firewall (allow only this consumer)
const allowedConsumerPublicKey: string | undefined = process.argv[4];

console.log(`🚀 Starting provider service with topic: ${topic}...`);

try {
  if (allowedConsumerPublicKey) {
    console.log(
      `🔒 Firewall enabled: only allowing consumer ${allowedConsumerPublicKey}`,
    );
  }

  // Start the provider service with optional firewall and seed
  const response = await startQVACProvider({
    topic,
    firewall: allowedConsumerPublicKey
      ? {
          mode: "allow" as const,
          publicKeys: [allowedConsumerPublicKey],
        }
      : undefined,
  });

  console.log("✅ Provider service started successfully!");
  console.log("🔗 Provider is now available for delegated inference requests");
  console.log("");
  console.log("📋 Connection Details:");
  console.log(`   📡 Topic (shared): ${topic}`);
  console.log(`   🆔 Provider Public Key (unique): ${response.publicKey}`);
  console.log("");
  console.log("💡 Consumer command:");
  console.log(`   node consumer.ts ${topic} ${response.publicKey}`);
  console.log("");
  console.log("💡 To reproduce this provider identity:");
  console.log(`   node provider.ts ${topic} ${seed || "<random-seed>"}`);
  if (!seed) {
    console.log(
      "   (Note: seed was random this time, set one for reproducible identity)",
    );
  }
  console.log("");
  console.log("🔒 For firewall testing:");
  console.log("   1. Generate a consumer seed (64-char hex)");
  console.log(
    "   2. Get consumer public key: getConsumerPublicKey(consumerSeed)",
  );
  console.log(
    "   3. Restart provider with consumer public key as 4th argument",
  );
  console.log(
    `   4. Run consumer with: node consumer.ts ${topic} ${response.publicKey} <consumer-seed>`,
  );

  // Keep the process running
  console.log("📡 Provider is running... Press Ctrl+C to stop");
  process.on("SIGINT", () => {
    console.log("\n🛑 Provider service stopped");
    process.exit(0);
  });

  process.stdin.resume();
} catch (error) {
  console.error("❌ Error:", error);
  process.exit(1);
}
