#!/usr/bin/env bun
/**
 * Generate the API summary MDX for one SDK version.
 *
 * Output target:
 *   - latest:  content/docs/reference/api/index.mdx
 *   - older:   content/docs/reference/api/v<X.Y.Z>.mdx
 *   - --target=<file>: content/docs/reference/api/<file> (override; used by
 *     the patch-archived flow to write into a renamed sibling).
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
 * Title-only mode (`--title-only`) skips Phase 1 + Phase 1.5 + the full
 * render. It opens the existing target MDX, rewrites only the frontmatter
 * `title:` line to the new version label, and keeps the body verbatim.
 * Used by the patch flow so we never re-run TypeDoc for a patch (patches
 * must not change the public API surface — that would be a minor).
 *
 * Usage:
 *   bun run scripts/generate-api-docs.ts <version> [--no-ai] [--force-extract]
 *   bun run scripts/generate-api-docs.ts <version> --latest
 *   bun run scripts/generate-api-docs.ts <version> --title-only [--latest|--target=<file>]
 *
 * Flags:
 *   --latest          Mark this version as the latest. Writes to index.mdx
 *                     instead of v<X.Y.Z>.mdx.
 *   --target=<file>   Override the output filename inside the API section
 *                     directory (e.g. `--target=v0.8.2.mdx`). Mutually
 *                     exclusive with `--latest`.
 *   --title-only      Skip TypeDoc + AI + render. Only rewrite the
 *                     frontmatter title of the existing target file.
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
import { rewriteFrontmatterTitleLine } from "./lib/release-shared.js";

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
  titleOnly: boolean;
  target: string | null;
}

async function generateApiDocs(version: string, options: GenerateOptions) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `Invalid version format: "${version}"\nExpected semver: X.Y.Z (e.g., 0.9.1)`,
    );
  }

  if (options.isLatest && options.target) {
    throw new Error(
      `--latest and --target=<file> are mutually exclusive: --latest implies index.mdx`,
    );
  }

  const versionLabel = options.isLatest ? `v${version} (latest)` : `v${version}`;

  const apiDir = path.join(
    DOCS_WEBSITE_DIR,
    "content",
    "docs",
    "reference",
    "api",
  );

  const outputFile = path.join(
    apiDir,
    options.target ??
      (options.isLatest ? "index.mdx" : `v${version}.mdx`),
  );

  if (options.titleOnly) {
    console.log(`📝 Title-only update for ${versionLabel}...`);
    console.log(`   Target: ${outputFile}`);
    await rewriteFrontmatterTitle(outputFile, versionLabel);
    await smokeTest(outputFile);
    console.log(`✅ Title-only update complete (${versionLabel})`);
    console.log(`   Location: ${outputFile}`);
    return;
  }

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

  await renderApiDocs(API_DATA_PATH, {
    versionLabel,
    outputFile,
  });

  await smokeTest(outputFile);

  console.log(`✅ API docs generation complete for ${versionLabel}`);
  console.log(`   Location: ${outputFile}`);
}

/**
 * Rewrite the `title:` line inside the frontmatter block of an existing
 * MDX file without touching the body. Used by `--title-only` so a patch
 * release bumps the displayed version label without re-running TypeDoc.
 *
 * The full title format is kept in lockstep with the title template in
 * `scripts/api-docs/templates/single-page.njk` so title-only patches
 * produce byte-identical headers to a full render at the same version.
 *
 * Thin wrapper around `rewriteFrontmatterTitleLine` from
 * `lib/release-shared.ts`: the wrapper owns the "API Summary — ..." prefix
 * so the lib stays prefix-agnostic and the release-notes generator can
 * reuse the same helper with its own prefix.
 *
 * Exported so unit tests can validate the body-preserving behaviour
 * without spinning up the full TypeDoc pipeline.
 */
export async function rewriteFrontmatterTitle(
  filePath: string,
  versionLabel: string,
): Promise<void> {
  await rewriteFrontmatterTitleLine(
    filePath,
    `API Summary — ${versionLabel}`,
  );
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

// CLI — only runs when this module is invoked directly (not when imported
// for unit tests). `import.meta.main` is true under both Bun and Node 24+.
if (import.meta.main) {
  const args = process.argv.slice(2);
  const versionArg = args.find((arg) => !arg.startsWith("--"));
  const isLatest = args.includes("--latest");
  const forceExtract = args.includes("--force-extract");
  const noAi = args.includes("--no-ai");
  const titleOnly = args.includes("--title-only");
  const targetFlag = args.find((arg) => arg.startsWith("--target="));
  const target = targetFlag ? targetFlag.slice("--target=".length) : null;

  if (!versionArg) {
    console.error("❌ Error: Version argument required\n");
    console.error("Usage:");
    console.error("  bun run scripts/generate-api-docs.ts <version> [flags]\n");
    console.error("Flags:");
    console.error(
      "  --latest          Write to index.mdx instead of v<version>.mdx",
    );
    console.error(
      "  --target=<file>   Override output filename inside api/ (mutually exclusive with --latest)",
    );
    console.error(
      "  --title-only      Rewrite frontmatter title in-place (skips TypeDoc + render)",
    );
    console.error("  --no-ai           Skip AI augmentation (CI default)");
    console.error(
      "  --force-extract   Bypass mtime cache and re-run TypeDoc extraction\n",
    );
    console.error("Examples:");
    console.error("  bun run scripts/generate-api-docs.ts 0.9.1 --latest");
    console.error("  bun run scripts/generate-api-docs.ts 0.8.0 --no-ai");
    console.error(
      "  bun run scripts/generate-api-docs.ts 0.8.2 --target=v0.8.2.mdx --title-only",
    );
    process.exit(1);
  } else {
    generateApiDocs(versionArg, {
      isLatest,
      forceExtract,
      noAi,
      titleOnly,
      target,
    }).catch((error) => {
      console.error("❌ Error generating API docs:", error.message);
      if (error.stack) console.error("\nStack trace:", error.stack);
      process.exit(1);
    });
  }
}
