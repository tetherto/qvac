import { spawn, type ChildProcess } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  completion,
  loadModel,
  close,
  LLAMA_3_2_1B_INST_Q4_0,
} from "@qvac/sdk";

// The consumer connects to the provider directly via its public key over the
// DHT (`dht.connect(publicKey)`). No topic or discovery step is involved —
// the provider just needs its DHT server listening on its keyPair.
const PROVIDER_STARTUP_TIMEOUT_MS = 60_000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const providerScript = join(__dirname, "provider.ts");

function spawnProviderProcess(): ChildProcess {
  const child = spawn("bun", ["run", providerScript], {
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
// generated at startup — it can't be known ahead of time. We parse it from
// the provider's stdout where it prints:
//   "▸ Provider Public Key: <hex>"
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

      const match = output.match(/Provider Public Key: ([a-f0-9]+)/i);
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

async function runDelegatedCompletion(
  providerPublicKey: string,
): Promise<void> {
  console.log("▸ Loading model via delegation...");
  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    delegate: {
      providerPublicKey,
      timeout: 30_000,
    },
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
      if (p.percentage >= 100) process.stderr.write("\n");
    },
  });
  console.log(`▸ Model loaded: ${modelId}`);

  console.log("▸ Running delegated completion (streamed)...");
  const response = completion({
    modelId,
    history: [{ role: "user", content: "Say hello in exactly 5 words." }],
    stream: true,
  });

  console.log("▸ Response:");
  for await (const token of response.tokenStream) {
    process.stdout.write(token);
  }

  const stats = await response.stats;
  console.log(`\n▸ Stats: ${JSON.stringify(stats)}`);
}

const provider = spawnProviderProcess();

try {
  console.log("▸ Waiting for provider to start and announce its key...");
  const publicKey = await waitForProviderPublicKey(provider);

  console.log(`\n▸ Provider ready — key: ${publicKey}\n`);

  await runDelegatedCompletion(publicKey);
  void close();
} finally {
  terminateProvider(provider);
}

process.exit(0);
