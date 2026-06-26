import { app } from "electron";
import { pathToFileURL } from "node:url";

app.commandLine.appendSwitch("no-sandbox");

async function startConfiguredConsumer() {
  const entryPath = process.env["QVAC_TEST_CONSUMER_ENTRY"];
  if (!entryPath) {
    throw new Error("QVAC_TEST_CONSUMER_ENTRY is required");
  }

  const entry = (await import(pathToFileURL(entryPath).href)) as {
    startElectronConsumer?: () => Promise<void>;
  };
  if (typeof entry.startElectronConsumer !== "function") {
    throw new Error(`Electron consumer entry must export startElectronConsumer(): ${entryPath}`);
  }

  await entry.startElectronConsumer();
}

app.whenReady()
  .then(async () => {
    console.log("[electron-e2e] app ready");
    await startConfiguredConsumer();
  })
  .catch((error: unknown) => {
    console.error("[electron-e2e] failed to start:", error);
    app.exit(1);
  });

