import { startQVACProvider, stopQVACProvider } from "@qvac/sdk";

try {
  const response = await startQVACProvider();
  process.stdout.write(
    JSON.stringify({ ready: true, publicKey: response.publicKey }) + "\n",
  );

  const cleanup = async () => {
    try {
      await stopQVACProvider();
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
