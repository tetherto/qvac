#!/usr/bin/env bun
/**
 * Release a new docs version (single-page-per-version model).
 *
 * Steps performed (idempotent within a single SDK release):
 *   1. Snapshot the current `index.mdx` of each versioned section into a
 *      sibling `v<outgoing>.mdx` (delegated to `create-version-bundle.ts`).
 *   2. Generate the new API summary into `index.mdx` for the incoming
 *      version (delegated to `generate-api-docs.ts --latest`).
 *   3. Generate the new release notes into `index.mdx` (delegated to
 *      `generate-release-notes.ts --latest --aggregate-minor`).
 *   4. Refresh `src/lib/versions.ts` from disk so the version selector
 *      reflects the new state (delegated to `update-versions-list.ts`).
 *   5. Optionally commit and open a PR to `docs-production`.
 *
 * Usage:
 *   bun run scripts/release-version.ts <new-version>
 *                                      [--no-commit] [--no-pr]
 *                                      [--force-extract] [--ai]
 *
 * Flags:
 *   --no-commit       Skip the automatic git commit step (CI default).
 *   --no-pr           Skip opening the docs-production PR (CI default).
 *   --force-extract   Bypass the mtime-based extraction cache (forwarded
 *                     to `generate-api-docs.ts`). Use in CI to guarantee
 *                     deterministic regeneration.
 *   --ai              Enable AI augmentation in `generate-api-docs.ts`.
 *                     Disabled by default so output stays reproducible
 *                     and CI doesn't depend on a remote LLM.
 *
 * Example (releasing v0.10.0 when current latest is v0.9.1):
 *   bun run scripts/release-version.ts 0.10.0
 */

import * as fs from "fs/promises";
import * as path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCS_WEBSITE_DIR = path.resolve(SCRIPT_DIR, "..");

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function readLatestFromVersionsTs(): string | null {
  const versionsPath = path.join(DOCS_WEBSITE_DIR, "src", "lib", "versions.ts");
  try {
    const content = require("fs").readFileSync(versionsPath, "utf-8");
    const match = content.match(/latest:\s*'(v\d+\.\d+\.\d+)'/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function runStep(label: string, cmd: string): void {
  console.log(`\n${label}`);
  console.log(`   $ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: DOCS_WEBSITE_DIR });
}

async function releaseVersion(
  newVersion: string,
  options: {
    commit: boolean;
    pr: boolean;
    forceExtract: boolean;
    ai: boolean;
  },
) {
  if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
    throw new Error(
      `Invalid version format: "${newVersion}"\nExpected semver: X.Y.Z (e.g., 0.10.0)`,
    );
  }

  const incoming = `v${newVersion}`;
  const outgoing = readLatestFromVersionsTs();

  console.log(`📦 Releasing docs ${incoming}`);
  console.log(`   Outgoing: ${outgoing ?? "(unknown)"}`);
  console.log(`   Incoming: ${incoming}`);

  if (outgoing && outgoing === incoming) {
    throw new Error(
      `New version ${incoming} is already the current latest. Nothing to do.`,
    );
  }

  // Sanity check: the index files must exist before we freeze them.
  const apiIndex = path.join(
    DOCS_WEBSITE_DIR,
    "content",
    "docs",
    "sdk",
    "api",
    "index.mdx",
  );
  if (!(await fileExists(apiIndex))) {
    throw new Error(`API summary index missing: ${apiIndex}`);
  }

  if (outgoing) {
    const outgoingNumeric = outgoing.replace(/^v/, "");
    runStep(
      `1️⃣  Freezing outgoing ${outgoing}...`,
      `bun run scripts/create-version-bundle.ts ${outgoingNumeric}`,
    );
  } else {
    console.log(
      `\n1️⃣  Skipping freeze step (no previous latest detected in versions.ts).`,
    );
  }

  // Compose the inner generate-api-docs flags. CI defaults are
  // `--no-ai --force-extract` for reproducibility; local runs default to
  // `--no-ai` (cache on) and let the developer opt into `--ai`.
  const apiFlags: string[] = ["--latest"];
  if (!options.ai) apiFlags.push("--no-ai");
  if (options.forceExtract) apiFlags.push("--force-extract");

  runStep(
    `2️⃣  Generating ${incoming} API summary...`,
    `bun run scripts/generate-api-docs.ts ${newVersion} ${apiFlags.join(" ")}`,
  );

  runStep(
    `3️⃣  Generating ${incoming} release notes (aggregating minor)...`,
    `bun run scripts/generate-release-notes.ts ${newVersion} --latest --aggregate-minor`,
  );

  runStep(
    `4️⃣  Updating versions list...`,
    `bun run scripts/update-versions-list.ts --latest=${newVersion}`,
  );

  if (options.commit) {
    console.log(`\n5️⃣  Committing changes...`);
    try {
      execSync(`git add -A`, { stdio: "inherit", cwd: DOCS_WEBSITE_DIR });
      execSync(`git commit -m "doc: release docs ${incoming}"`, {
        stdio: "inherit",
        cwd: DOCS_WEBSITE_DIR,
      });
      console.log(`✓ Committed to current branch`);
    } catch {
      console.log(`⚠️  Git commit skipped (no changes or not a git repo)`);
    }
  }

  if (options.pr) {
    console.log(`\n6️⃣  Opening PR to docs-production...`);
    try {
      execSync(`git push -u origin HEAD`, {
        stdio: "inherit",
        cwd: DOCS_WEBSITE_DIR,
      });
      execSync(
        `gh pr create --base docs-production --head main ` +
          `--title "doc: release docs ${incoming}" ` +
          `--body "Promotes ${incoming} API summary and release notes to latest. Freezes ${outgoing ?? "(none)"} as a sibling MDX."`,
        { stdio: "inherit", cwd: DOCS_WEBSITE_DIR },
      );
      console.log(`✓ PR created`);
    } catch {
      console.log(
        `⚠️  PR creation skipped (gh CLI not available or PR already exists)`,
      );
    }
  }

  console.log(`\n✅ Release ${incoming} complete`);
}

const args = process.argv.slice(2);
const versionArg = args.find((a) => !a.startsWith("--"));
const noCommit = args.includes("--no-commit");
const noPr = args.includes("--no-pr");
const forceExtract = args.includes("--force-extract");
const ai = args.includes("--ai");

if (!versionArg || args.includes("--help") || args.includes("-h")) {
  console.log(
    "Usage: bun run scripts/release-version.ts <new-version> [flags]",
  );
  console.log("");
  console.log(
    "Releases a new docs version: snapshots the outgoing index.mdx, generates",
  );
  console.log(
    "the incoming API summary and release notes, and refreshes versions.ts.",
  );
  console.log("");
  console.log("Flags:");
  console.log("  --no-commit       Skip the automatic git commit step.");
  console.log("  --no-pr           Skip opening the docs-production PR.");
  console.log(
    "  --force-extract   Bypass the mtime-based extraction cache (CI default).",
  );
  console.log(
    "  --ai              Enable AI augmentation (off by default).",
  );
  process.exit(versionArg ? 0 : 1);
}

releaseVersion(versionArg, {
  commit: !noCommit,
  pr: !noPr,
  forceExtract,
  ai,
}).catch((err) => {
  console.error(`❌ Release failed: ${err.message}`);
  process.exit(1);
});
