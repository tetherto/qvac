#!/usr/bin/env bun
/**
 * Generate the API summary MDX for one SDK version.
 *
 * Output target:
 *   - latest:  content/docs/sdk/api/index.mdx
 *   - older:   content/docs/sdk/api/v<X.Y.Z>.mdx
 *
 * The pipeline is:
 *   1. Phase 1 — Extract: TypeDoc walks the SDK and writes api-data.json
 *      (signatures, top-level descriptions, throws, examples, deprecated,
 *      errors). Scope is restricted to functions re-exported from
 *      `packages/sdk/client/api/index.ts` plus the `profiler` object.
 *   2. Phase 1.5 — AI augmentation (optional): fills in missing prose. Skipped
 *      with `--no-ai` and disabled by default in CI to keep output reproducible.
 *   3. Phase 2 — Render: writes a single MDX through `single-page.njk`.
 *
 * Usage:
 *   bun run scripts/generate-api-docs.ts <version> [--no-ai] [--force-extract]
 *   bun run scripts/generate-api-docs.ts <version> --latest
 *
 * Flags:
 *   --latest          Mark this version as the latest. Writes to index.mdx
 *                     instead of v<X.Y.Z>.mdx.
 *   --no-ai           Skip the AI augmentation phase (CI default).
 *   --force-extract   Bypass mtime-based extraction cache.
 *
 * SDK_PATH env: override the SDK source root (default: ../../../packages/sdk
 * relative to this script).
 *
 * SOURCE_DATE_EPOCH env: when set, ApiData.generatedAt becomes a deterministic
 * ISO timestamp (reproducible-builds convention). When unset it falls back to
 * the literal string "unspecified" so byte-identity tests pass without env.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "node:url";
import { extractApiData } from "./api-docs/extract.js";
import { renderApiDocs } from "./api-docs/render.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const API_DATA_PATH = path.join(SCRIPT_DIR, "api-docs", "api-data.json");

// Resolve paths relative to this script's location (docs/website/scripts/)
// rather than process.cwd() so the generator works whether invoked from the
// repo root, from docs/website, or via `npm run` proxies.
const DOCS_WEBSITE_DIR = path.resolve(SCRIPT_DIR, "..");
const SDK_PATH =
  process.env.SDK_PATH ||
  path.resolve(SCRIPT_DIR, "..", "..", "..", "packages", "sdk");

interface GenerateOptions {
  isLatest: boolean;
  forceExtract: boolean;
  noAi: boolean;
}

async function generateApiDocs(version: string, options: GenerateOptions) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `Invalid version format: "${version}"\nExpected semver: X.Y.Z (e.g., 0.9.1)`,
    );
  }

  const versionLabel = options.isLatest ? `v${version} (latest)` : `v${version}`;
  console.log(`📚 Generating API summary for ${versionLabel}...`);
  console.log(`   SDK path: ${SDK_PATH}`);

  // Phase 1: Extract
  await extractApiData(SDK_PATH, version, {
    forceExtract: options.forceExtract,
  });

  // Phase 1.5: AI augmentation (optional, non-fatal on failure)
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

  // Phase 2: Render to a single MDX file.
  const apiDir = path.join(DOCS_WEBSITE_DIR, "content", "docs", "sdk", "api");
  const outputFile = path.join(
    apiDir,
    options.isLatest ? "index.mdx" : `v${version}.mdx`,
  );

  await renderApiDocs(API_DATA_PATH, {
    versionLabel,
    outputFile,
  });

  await smokeTest(outputFile);

  console.log(`✅ API docs generation complete for ${versionLabel}`);
  console.log(`   Location: ${outputFile}`);
}

/**
 * Verify the generated file is well-formed MDX with the structural markers
 * the website depends on. Catches accidental template breakage in CI before
 * a broken doc reaches production.
 */
async function smokeTest(filePath: string): Promise<void> {
  console.log(`🧪 Running smoke test...`);

  const content = await fs.readFile(filePath, "utf-8");
  if (!content.startsWith("---\n")) {
    throw new Error(
      `Smoke test failed: ${path.basename(filePath)} is missing frontmatter`,
    );
  }
  for (const required of ["title:", "description:"]) {
    if (!content.includes(required)) {
      throw new Error(
        `Smoke test failed: ${path.basename(filePath)} is missing ${required}`,
      );
    }
  }
  for (const heading of ["## Functions", "## Errors"]) {
    if (!content.includes(heading)) {
      throw new Error(
        `Smoke test failed: ${path.basename(filePath)} is missing ${heading} section`,
      );
    }
  }

  console.log(`✅ Smoke test passed`);
}

// CLI
const args = process.argv.slice(2);
const versionArg = args.find((arg) => !arg.startsWith("--"));
const isLatest = args.includes("--latest");
const forceExtract = args.includes("--force-extract");
const noAi = args.includes("--no-ai");

if (!versionArg) {
  console.error("❌ Error: Version argument required\n");
  console.error("Usage:");
  console.error("  bun run scripts/generate-api-docs.ts <version> [flags]\n");
  console.error("Flags:");
  console.error(
    "  --latest          Write to index.mdx instead of v<version>.mdx",
  );
  console.error("  --no-ai           Skip AI augmentation (CI default)");
  console.error(
    "  --force-extract   Bypass mtime cache and re-run TypeDoc extraction\n",
  );
  console.error("Examples:");
  console.error("  bun run scripts/generate-api-docs.ts 0.9.1 --latest");
  console.error("  bun run scripts/generate-api-docs.ts 0.8.0 --no-ai");
  process.exit(1);
} else {
  generateApiDocs(versionArg, { isLatest, forceExtract, noAi }).catch(
    (error) => {
      console.error("❌ Error generating API docs:", error.message);
      if (error.stack) console.error("\nStack trace:", error.stack);
      process.exit(1);
    },
  );
}
