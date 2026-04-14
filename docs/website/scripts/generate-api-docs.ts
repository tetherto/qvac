#!/usr/bin/env bun
/**
 * Generate API documentation from TypeScript source (TypeDoc → MDX).
 * Thin orchestrator that delegates to extract.ts (Phase 1) and render.ts (Phase 2).
 *
 * Usage:
 *   bun run scripts/generate-api-docs.ts <version> [--no-update-latest] [--force-extract] [--no-ai]
 *   bun run scripts/generate-api-docs.ts --dev [--force-extract] [--no-ai]
 *   bun run scripts/generate-api-docs.ts --rollback
 *
 * --dev writes to content/docs/dev/sdk/api/ without creating a versioned folder
 * or updating (latest). Use during day-to-day development of the next version.
 *
 * --force-extract bypasses the mtime-based extraction cache and always re-runs
 * TypeDoc. Without it, extraction is skipped when api-data.json is newer than
 * all .ts files under the SDK source tree.
 *
 * Path format: content/docs/v{X.Y.Z}/sdk/api/ and content/docs/(latest)/sdk/api/
 * SDK path: Set SDK_PATH env to point to sdk package (default: ../../packages/sdk from cwd).
 */

import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "node:url";
import { extractApiData } from "./api-docs/extract.js";
import { renderApiDocs } from "./api-docs/render.js";
import type { GenerateOptions } from "./api-docs/types.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const API_DATA_PATH = path.join(SCRIPT_DIR, "api-docs", "api-data.json");

const SDK_PATH =
  process.env.SDK_PATH ||
  path.join(process.cwd(), "..", "..", "packages", "sdk");

async function generateApiDocs(
  version: string,
  options: GenerateOptions = { updateLatest: true },
) {
  if (!options.devMode && !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `Invalid version format: "${version}"\nExpected semver: X.Y.Z (e.g., 0.6.1)`,
    );
  }

  const label = options.devMode ? "dev" : `v${version}`;
  console.log(`📚 Generating API docs for ${label}...`);
  if (!options.devMode) {
    console.log(
      `   Update latest: ${options.updateLatest ? "yes" : "no (backfill mode)"}`,
    );
  }
  console.log(`   SDK path: ${SDK_PATH}`);

  // Phase 1: Extract
  await extractApiData(SDK_PATH, version, {
    forceExtract: options.forceExtract,
  });

  // Phase 1.5: AI augmentation (optional)
  if (!options.noAi) {
    try {
      const { isAugmentConfigured, augmentApiData } = await import(
        "./api-docs/ai-augment.js"
      );
      if (isAugmentConfigured()) {
        console.log("🤖 Running AI augmentation...");
        const result = await augmentApiData(API_DATA_PATH);
        console.log(
          `✓ AI augmentation: ${result.augmented} augmented, ${result.skipped} skipped`,
        );
      } else {
        console.log("⏭️  Skipping AI augmentation (env vars not configured)");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`⚠️  AI augmentation failed (non-fatal): ${msg}`);
    }
  }

  // Phase 2: Render
  const outputFolder = options.devMode ? "dev" : `v${version}`;
  const outputDir = path.join(
    process.cwd(),
    "content",
    "docs",
    outputFolder,
    "sdk",
    "api",
  );
  await renderApiDocs(API_DATA_PATH, outputDir, { versionLabel: label });

  if (!options.devMode && options.updateLatest) {
    await updateLatestSafely(version);
  } else if (!options.devMode) {
    console.log(`⏭️  Skipping latest update (--no-update-latest flag)`);
  }

  await smokeTestDir(outputDir);

  console.log(`✅ API docs generation complete for ${label}`);
  console.log(`   Location: ${outputDir}`);
}

// ---------------------------------------------------------------------------
// Latest management & smoke test
// ---------------------------------------------------------------------------

async function updateLatestSafely(version: string) {
  const docsBase = path.join(process.cwd(), "content", "docs");
  const latestApiDir = path.join(docsBase, "(latest)", "sdk", "api");
  const versionApiDir = path.join(docsBase, `v${version}`, "sdk", "api");
  const backupDir = path.join(docsBase, ".latest-api-backup");

  console.log(`📌 Updating (latest)/sdk/api/ to match v${version}...`);

  try {
    const stat = await fs.stat(latestApiDir);
    if (stat.isDirectory()) {
      await fs.rm(backupDir, { recursive: true, force: true });
      await fs.cp(latestApiDir, backupDir, { recursive: true });
      console.log("✓ Backed up current (latest)/sdk/api/ → .latest-api-backup");
    }
  } catch {
    console.log("✓ No previous (latest)/sdk/api/ to backup (first generation)");
  }

  await fs.rm(latestApiDir, { recursive: true, force: true });
  await fs.cp(versionApiDir, latestApiDir, { recursive: true });
  console.log(`✓ Updated (latest)/sdk/api/ → v${version}`);
}

async function smokeTestDir(apiDir: string): Promise<void> {
  console.log(`🧪 Running smoke test...`);

  const indexPath = path.join(apiDir, "index.mdx");
  await fs.stat(indexPath);

  const files = await fs.readdir(apiDir);
  const mdxFiles = files.filter(
    (f) => f.endsWith(".mdx") && f !== "index.mdx",
  );
  if (mdxFiles.length === 0) {
    throw new Error("Smoke test failed: No function docs generated");
  }

  for (const file of mdxFiles) {
    const content = await fs.readFile(
      path.join(apiDir, file),
      "utf-8",
    );
    if (!content.startsWith("---\n")) {
      throw new Error(
        `Smoke test failed: Invalid MDX in ${file} (missing frontmatter)`,
      );
    }
    if (!content.includes("title:") || !content.includes("description:")) {
      throw new Error(
        `Smoke test failed: Invalid MDX in ${file} (missing required fields)`,
      );
    }
  }

  console.log(`✅ Smoke test passed (${mdxFiles.length} files verified)`);
}

async function rollbackLatest(): Promise<void> {
  const docsBase = path.join(process.cwd(), "content", "docs");
  const latestApiDir = path.join(docsBase, "(latest)", "sdk", "api");
  const backupDir = path.join(docsBase, ".latest-api-backup");

  const backupExists = await fs
    .stat(backupDir)
    .then(() => true)
    .catch(() => false);
  if (!backupExists) {
    console.log("⚠️  No backup available to rollback to");
    return;
  }

  await fs.rm(latestApiDir, { recursive: true, force: true });
  await fs.cp(backupDir, latestApiDir, { recursive: true });
  await fs.rm(backupDir, { recursive: true, force: true });
  console.log("✅ Rolled back (latest)/sdk/api/ to previous version");
}

// CLI
const args = process.argv.slice(2);
const versionArg = args.find((arg) => !arg.startsWith("--"));
const updateLatest = !args.includes("--no-update-latest");
const rollback = args.includes("--rollback");
const devMode = args.includes("--dev");
const forceExtract = args.includes("--force-extract");
const noAi = args.includes("--no-ai");

if (rollback) {
  rollbackLatest()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("❌ Rollback failed:", err);
      process.exit(1);
    });
} else if (devMode) {
  generateApiDocs("dev", { updateLatest: false, devMode: true, forceExtract, noAi }).catch((error) => {
    console.error("❌ Error generating dev API docs:", error.message);
    if (error.stack) console.error("\nStack trace:", error.stack);
    process.exit(1);
  });
} else if (!versionArg) {
  console.error("❌ Error: Version argument required (or use --dev)\n");
  console.error("Usage:");
  console.error("  bun run scripts/generate-api-docs.ts <version> [flags]");
  console.error("  bun run scripts/generate-api-docs.ts --dev\n");
  console.error("Flags:");
  console.error(
    "  --dev                 Generate into dev/sdk/api/ (no versioned folder)",
  );
  console.error(
    "  --no-update-latest    Skip updating latest/ (use for backfills)",
  );
  console.error("  --rollback            Restore previous version of latest/");
  console.error(
    "  --force-extract       Bypass mtime cache and re-run TypeDoc extraction",
  );
  console.error(
    "  --no-ai               Skip AI augmentation step\n",
  );
  console.error("Examples:");
  console.error("  bun run scripts/generate-api-docs.ts --dev");
  console.error("  bun run scripts/generate-api-docs.ts 0.6.1");
  console.error(
    "  bun run scripts/generate-api-docs.ts 0.5.0 --no-update-latest",
  );
  console.error("  bun run scripts/generate-api-docs.ts --rollback");
  process.exit(1);
} else {
  generateApiDocs(versionArg, { updateLatest, forceExtract, noAi }).catch((error) => {
    console.error("❌ Error generating API docs:", error.message);
    if (error.stack) console.error("\nStack trace:", error.stack);
    if (updateLatest) {
      console.log("\n🔄 Attempting rollback...");
      rollbackLatest().catch((e) =>
        console.error("❌ Rollback also failed:", e),
      );
    }
    process.exit(1);
  });
}
