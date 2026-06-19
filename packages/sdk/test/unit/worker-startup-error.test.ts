import test from "brittle";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nativeLoadErrorMarker = "QVAC_REPRO_NATIVE_LOAD_ERROR";

function collectErrorDetails(error: Error | undefined) {
  if (!error) return "";

  const cause = (error as { cause?: unknown }).cause;
  const causeMessage = cause instanceof Error ? cause.message : "";
  return `${error.message}\n${causeMessage}`;
}

test("loadModel() startup failure includes worker stderr in RPC init error cause", async function (t) {
  t.timeout(15_000);

  process.env["QVAC_WORKER_PATH"] = path.resolve(
    __dirname,
    "fixtures/native-load-failure-worker.mjs",
  );

  const { loadModel } = await import("@/client/api/load-model");
  const { close } = await import("@/client/rpc/rpc-client");

  t.teardown(async () => {
    try {
      await close();
    } catch {}
    delete process.env["QVAC_WORKER_PATH"];
  });

  let startupError: Error | undefined;
  try {
    await loadModel({
      modelSrc: "/tmp/qvac-repro-model.gguf",
      modelType: "llamacpp-completion",
    });
    t.fail("loadModel() resolved unexpectedly - expected worker startup failure");
  } catch (error) {
    startupError = error as Error;
  }

  t.ok(startupError, "expected loadModel() to reject");
  t.is(
    (startupError as { name?: string } | undefined)?.name,
    "RPC_INIT_TIMEOUT",
    `expected RPC_INIT_TIMEOUT, got name=${(startupError as { name?: string } | undefined)?.name}`,
  );
  t.ok(
    collectErrorDetails(startupError).includes(nativeLoadErrorMarker),
    "expected SDK error details to include worker stderr",
  );
});
