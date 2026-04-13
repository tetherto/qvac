import { startQVACProvider, stopQVACProvider } from "@qvac/sdk";

const topic = process.argv[2];
if (!topic) {
  process.stderr.write("Usage: delegated-provider-process.js <topic>\n");
  process.exit(1);
}

try {
  const response = await startQVACProvider({ topic });
  process.stdout.write(
    JSON.stringify({ ready: true, publicKey: response.publicKey }) + "\n",
  );

  const cleanup = async () => {
    try {
      await stopQVACProvider({ topic });
    } catch {}
    process.exit(0);
  };

  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
  process.stdin.resume();
} catch (error) {
  process.stderr.write(
    `Provider startup failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
