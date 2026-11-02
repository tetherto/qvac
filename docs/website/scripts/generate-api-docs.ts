#!/usr/bin/env bun
/**
 * Generate the API summary MDX for one SDK version's minor series.
 *
 * Output target: the API summary of the SDK's current documentation line,
 * `content/docs/sdk/<current line>/reference/api.mdx`, resolved from the
 * version manifest. A released line is never regenerated — it is what the
 * site already serves — so there is one target and no way to name another.
 *
 * Patches never re-render or relabel the API summary: the public API is
 * frozen at the minor boundary, so a patch by definition adds nothing
 * here. The page's title and content reflect the minor series, not the
 * latest patch (`v0.11.x`, never `v0.11.3`).
 *
 * The pipeline is:
 *   1. Extract: TypeDoc walks the SDK and writes api-data.json (signatures,
 *      top-level descriptions, throws, examples, deprecated, errors). Scope
 *      is restricted to functions re-exported from
 *      `packages/sdk/client/api/index.ts` plus the `profiler` object.
 *   2. Render: writes a single MDX through `single-page.njk`.
 *
 * Title-only mode (`--title-only`) skips extraction and the full render.
 * It opens the existing target MDX and rewrites only the frontmatter
 * `title:` line — used by the minor orchestrator to relabel a freshly
 * frozen series snapshot (which inherits the outgoing `index.mdx` title
 * verbatim, still carrying the `(latest)` marker) without touching the
 * body.
 *
 * The title always marks the page as the latest, because the only line this
 * can write to is the current one. A cut is what moves that marker, and a
 * regeneration that dropped it would demote the line it just wrote into.
 *
 * Usage:
 *   bun run scripts/generate-api-docs.ts <version> [--force-extract]
 *   bun run scripts/generate-api-docs.ts <version> --title-only
 *
 * Flags:
 *   --title-only      Skip TypeDoc + render. Only rewrite the
 *                     frontmatter title of the existing page.
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
import {
  apiPageFor,
  parseVersion,
  rewriteFrontmatterTitleLine,
  seriesName,
} from "./lib/release-shared.js";

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
  forceExtract: boolean;
  titleOnly: boolean;
}

async function generateApiDocs(version: string, options: GenerateOptions) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `Invalid version format: "${version}"\nExpected semver: X.Y.Z (e.g., 0.11.0)`,
    );
  }

  const parsed = parseVersion(version);
  const series = seriesName(parsed);
  // Series-only labels: patches don't change the API summary, so the
  // title never carries a precise patch number — only the minor line. The
  // marker is unconditional: the target is the current line or there is none.
  const versionLabel = `${series} (latest)`;

  const outputFile = apiPageFor(parsed);

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

  await extractApiData(SDK_PATH, version, {
    forceExtract: options.forceExtract,
  });

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
  const forceExtract = args.includes("--force-extract");
  const titleOnly = args.includes("--title-only");

  if (args.some((arg) => arg.startsWith("--target="))) {
    console.error(
      "❌ --target is gone: the API summary is one page per documentation " +
        "line, written to the current line the manifest declares.",
    );
    process.exit(1);
  }

  if (!versionArg) {
    console.error("❌ Error: Version argument required\n");
    console.error("Usage:");
    console.error("  bun run scripts/generate-api-docs.ts <version> [flags]\n");
    console.error("Flags:");
    console.error(
      "  --title-only      Rewrite frontmatter title in-place (skips TypeDoc + render)",
    );
    console.error(
      "  --force-extract   Bypass mtime cache and re-run TypeDoc extraction\n",
    );
    console.error("Examples:");
    console.error("  bun run scripts/generate-api-docs.ts 0.21.0");
    console.error(
      "  bun run scripts/generate-api-docs.ts 0.21.1 --title-only",
    );
    process.exit(1);
  } else {
    generateApiDocs(versionArg, {
      forceExtract,
      titleOnly,
    }).catch((error) => {
      console.error("❌ Error generating API docs:", error.message);
      if (error.stack) console.error("\nStack trace:", error.stack);
      process.exit(1);
    });
  }
}
