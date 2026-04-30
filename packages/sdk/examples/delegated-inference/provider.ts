import { startQVACProvider } from "@qvac/sdk";

// Optional: Seed for deterministic provider identity (64-character hex string)
const seed: string | undefined = process.argv[2];

if (seed) {
  process.env["QVAC_HYPERSWARM_SEED"] = seed;
}

// Optional: Consumer public key for firewall (allow only this consumer)
const allowedConsumerPublicKey: string | undefined = process.argv[3];

console.log(`🚀 Starting provider service...`);

try {
  if (allowedConsumerPublicKey) {
    console.log(
      `🔒 Firewall enabled: only allowing consumer ${allowedConsumerPublicKey}`,
    );
  }

  const response = await startQVACProvider({
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
  console.log(`   🆔 Provider Public Key: ${response.publicKey}`);
  console.log("");
  console.log("💡 Consumer command:");
  console.log(`   node consumer.ts ${response.publicKey}`);
  console.log("");
  console.log("💡 To reproduce this provider identity:");
  console.log(`   node provider.ts ${seed || "<random-seed>"}`);
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
    "   3. Restart provider with consumer public key as 2nd argument",
  );
  console.log(
    `   4. Run consumer with: node consumer.ts ${response.publicKey} <consumer-seed>`,
  );

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
