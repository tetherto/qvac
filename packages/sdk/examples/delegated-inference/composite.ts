import { spawn, type ChildProcess } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  completion,
  loadModel,
  close,
  LLAMA_3_2_1B_INST_Q4_0,
} from "@qvac/sdk";

// ── Config ──────────────────────────────────────────────────────────
// Any 64-char hex string works as a topic — it's a shared secret that
// lets the consumer discover the provider on Hyperswarm.
const TOPIC =
  "66646f696865726f6569686a726530776a66646f696865726f6569686a726530";
const PROVIDER_STARTUP_TIMEOUT_MS = 30_000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const providerScript = join(__dirname, "provider.ts");

// ── Provider lifecycle ──────────────────────────────────────────────

function spawnProviderProcess(): ChildProcess {
  const child = spawn("bun", ["run", providerScript, TOPIC], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  return child;
}

function terminateProvider(provider: ChildProcess): void {
  if (!provider.killed) {
    provider.kill("SIGTERM");
  }
}

// The provider's Hyperswarm identity (and therefore its public key) is
// generated at startup — it can't be known ahead of time. We parse it
// from the provider's stdout where it prints:
//   "🆔 Provider Public Key (unique): <hex>"
function waitForProviderPublicKey(provider: ChildProcess): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let output = "";

    const timeout = setTimeout(() => {
      reject(new Error("Provider did not emit its public key in time"));
    }, PROVIDER_STARTUP_TIMEOUT_MS);

    provider.stdout!.on("data", (chunk: Buffer) => {
      const str = chunk.toString();
      output += str;
      process.stdout.write(str);

      const match = output.match(
        /Provider Public Key \(unique\): ([a-f0-9]+)/i,
      );
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]!);
      }
    });

    provider.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    provider.on("close", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Provider exited unexpectedly (code ${String(code)})`));
    });
  });
}

// ── Consumer: delegated model load + completion ─────────────────────

async function runDelegatedCompletion(
  topic: string,
  providerPublicKey: string,
): Promise<void> {
  console.log("→ Loading model via delegation...");
  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelType: "llm",
    delegate: {
      topic,
      providerPublicKey,
      timeout: 30_000,
    },
    onProgress: (progress) => {
      console.log(`  Download: ${progress.percentage.toFixed(1)}%`);
    },
  });
  console.log(`✅ Model loaded: ${modelId}\n`);

  console.log("→ Running delegated completion (streamed)...");
  const response = completion({
    modelId,
    history: [{ role: "user", content: "Say hello in exactly 5 words." }],
    stream: true,
  });

  process.stdout.write("  Response: ");
  for await (const token of response.tokenStream) {
    process.stdout.write(token);
  }

  const stats = await response.stats;
  console.log(`\n📊 Stats: ${JSON.stringify(stats)}`);
}

// ── Main ────────────────────────────────────────────────────────────

const provider = spawnProviderProcess();

try {
  console.log("🔧 Waiting for provider to start and announce its key...\n");
  const publicKey = await waitForProviderPublicKey(provider);

  console.log(`\n📡 Provider ready — key: ${publicKey}`);
  console.log(`📡 Topic: ${TOPIC}\n`);

  await runDelegatedCompletion(TOPIC, publicKey);
  void close();
} finally {
  terminateProvider(provider);
}

process.exit(0);
