import fs from "fs";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { generateModelsFileContent } from "./codegen";
import {
  assignNames,
  compareModels,
  createHistoryFile,
  loadCurrentModels,
  separateUpdates,
} from "./history";
import { collectModels } from "./registry";
import { formatSize } from "./utils";

const OUTPUT_FILE = fileURLToPath(
  new URL("../registry/models.ts", import.meta.url),
);
const HISTORY_DIR = fileURLToPath(new URL("../history", import.meta.url));

async function checkOnly(
  nonBlocking = false,
  showDuplicates = false,
): Promise<void> {
  const timeoutMs = 30000;
  let timedOut = false;

  const timeoutPromise = new Promise<null>((resolve) => {
    setTimeout(() => {
      timedOut = true;
      console.log("⏱️  Model check timed out");
      console.log("   Run 'bun check-models' manually to retry");
      resolve(null);
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      (async () => {
        const remoteModels = await collectModels({ showDuplicates });
        const currentModels = loadCurrentModels(OUTPUT_FILE);

        remoteModels.sort(
          (a, b) =>
            a.addon.localeCompare(b.addon) ||
            a.registryPath.localeCompare(b.registryPath),
        );

        return { remoteModels, currentModels };
      })(),
      timeoutPromise,
    ]);

    if (timedOut || !result) {
      process.exit(nonBlocking ? 0 : 1);
    }

    const { remoteModels, currentModels } = result;
    const { added: rawAdded, removed: rawRemoved } = compareModels(
      remoteModels,
      currentModels,
    );

    if (rawAdded.length === 0 && rawRemoved.length === 0) {
      console.log(`✅ Models are up to date (${remoteModels.length} models)`);
      process.exit(0);
    }

    const addedWithNames = assignNames(rawAdded);
    const { added, updated, removed } = separateUpdates(
      addedWithNames,
      rawRemoved,
    );

    console.log("");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    if (added.length > 0) {
      console.log(
        `✨ ${added.length} new model${added.length === 1 ? "" : "s"} available:`,
      );
      added.slice(0, 10).forEach((m) => {
        console.log(
          `  + ${m.name} (${m.addon}, ${formatSize(m.expectedSize)})`,
        );
      });
      if (added.length > 10) {
        console.log(`  ... and ${added.length - 10} more`);
      }
    }

    if (updated.length > 0) {
      console.log(
        `\n🔄 ${updated.length} model${updated.length === 1 ? "" : "s"} updated:`,
      );
      updated.slice(0, 10).forEach((m) => {
        console.log(
          `  ~ ${m.name} (${m.addon}, ${formatSize(m.expectedSize)})`,
        );
      });
      if (updated.length > 10) {
        console.log(`  ... and ${updated.length - 10} more`);
      }
    }

    if (removed.length > 0) {
      console.log(
        `\n⚠️  ${removed.length} model${removed.length === 1 ? "" : "s"} removed:`,
      );
      removed.slice(0, 5).forEach((m) => {
        console.log(`  - ${m.name}`);
      });
      if (removed.length > 5) {
        console.log(`  ... and ${removed.length - 5} more`);
      }
    }

    console.log("");
    console.log(`💡 Run 'bun update-models' to sync changes`);
    console.log("");
    if (nonBlocking) {
      console.log("💡 Commit will proceed - update models when ready");
    }
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("");

    process.exit(nonBlocking ? 0 : 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("❌ Model check failed:", message);
    process.exit(nonBlocking ? 0 : 1);
  }
}

async function updateModels(
  showDuplicates = false,
  noDedup = false,
): Promise<void> {
  console.log("🔄 Fetching models from QVAC Registry...\n");

  const currentModels = loadCurrentModels(OUTPUT_FILE);
  const models = await collectModels({ showDuplicates, noDedup });
  const { added, removed } = compareModels(models, currentModels);

  models.sort(
    (a, b) =>
      a.addon.localeCompare(b.addon) ||
      a.registryPath.localeCompare(b.registryPath),
  );

  fs.writeFileSync(OUTPUT_FILE, generateModelsFileContent(models));

  try {
    execSync(`npx prettier --write "${OUTPUT_FILE}"`, { stdio: "pipe" });
  } catch {
    // prettier not available, skip formatting
  }

  console.log(`✅ Generated ${models.length} models → ${OUTPUT_FILE}`);

  const addedWithNames = assignNames(added);

  if (added.length > 0 || removed.length > 0) {
    const historyFile = createHistoryFile(
      addedWithNames,
      removed,
      currentModels,
      HISTORY_DIR,
    );
    if (historyFile) {
      const {
        added: trulyAdded,
        updated,
        removed: trulyRemoved,
      } = separateUpdates(addedWithNames, removed);
      console.log(`📜 Created history file → ${historyFile}`);
      console.log(
        `   Added: ${trulyAdded.length}, Updated: ${updated.length}, Removed: ${trulyRemoved.length}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const CHECK_ONLY = process.argv.includes("--check");
  const NON_BLOCKING = process.argv.includes("--non-blocking");
  const SHOW_DUPLICATES = process.argv.includes("--show-duplicates");
  const NO_DEDUP = process.argv.includes("--no-dedup");

  if (CHECK_ONLY) {
    await checkOnly(NON_BLOCKING, SHOW_DUPLICATES);
  } else {
    await updateModels(SHOW_DUPLICATES, NO_DEDUP);
  }
}

main().catch(console.error);
