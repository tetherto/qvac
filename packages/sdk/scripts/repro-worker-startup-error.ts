import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nativeLoadErrorMarker = "QVAC_REPRO_NATIVE_LOAD_ERROR";

function formatCause(error: Error | undefined) {
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  if (!cause) return "<none>";
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (typeof cause === "string") return cause;
  return Object.prototype.toString.call(cause);
}

function collectMessages(error: Error | undefined) {
  if (!error) return "";

  const cause = (error as { cause?: unknown }).cause;
  const causeMessage =
    cause instanceof Error ? cause.message : Object.prototype.toString.call(cause);
  return `${error.message}\n${causeMessage}`;
}

async function main() {
  process.env["QVAC_WORKER_PATH"] = path.resolve(
    __dirname,
    "../test/unit/fixtures/native-load-failure-worker.mjs",
  );

  const { loadModel } = await import("../client/api/load-model");
  const { close } = await import("../client/rpc/rpc-client");

  let startupError: Error | undefined;
  try {
    await loadModel({
      modelSrc: "/tmp/qvac-repro-model.gguf",
      modelType: "llamacpp-completion",
    });
  } catch (error) {
    startupError = error as Error;
  }

  try {
    await close();
  } catch {}

  if (!startupError) {
    console.error("Expected loadModel() to fail, but it resolved.");
    process.exit(1);
  }

  const name = (startupError as { name?: string }).name;
  const messages = collectMessages(startupError);

  if (name !== "RPC_INIT_TIMEOUT") {
    console.error(`Expected RPC_INIT_TIMEOUT, got ${name ?? "<missing>"}.`);
    console.error(startupError);
    process.exit(1);
  }

  console.log("\n=== SDK-facing error caught by the caller ===");
  console.log(`name: ${name}`);
  console.log(`message: ${startupError.message}`);
  console.log(`cause: ${formatCause(startupError)}`);

  if (!messages.includes(nativeLoadErrorMarker)) {
    console.error(
      `Expected SDK error details to include ${nativeLoadErrorMarker}.`,
    );
    process.exit(1);
  }

  console.log("\n=== Reproduction result ===");
  console.log("Fixed: loadModel() failed with RPC_INIT_TIMEOUT.");
  console.log(
    `The SDK error includes the underlying ${nativeLoadErrorMarker} marker.`,
  );
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
