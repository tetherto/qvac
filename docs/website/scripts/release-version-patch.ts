#!/usr/bin/env bun
/**
 * Orchestrator for **patch** docs releases (`X.Y.Z` with `Z >= 1`).
 *
 * Per the series-based versioning model:
 *
 *   - **API summary is NOT touched by patches.** Patches by definition
 *     don't add new public API surface (that would be a minor), so the
 *     `v<X.Y>.x.mdx` API page stays as it was after the minor release.
 *   - **Release notes are accumulated** under the existing
 *     `v<X.Y>.x.mdx` (or `index.mdx` when the patch targets the current
 *     latest minor). Each patch inserts its `## v<X.Y.Z>` section
 *     directly after the `## v<X.Y>.0` minor block, so the most recent
 *     patches sit right under the minor.
 *
 * Mode selection happens at runtime:
 *   - `patch-latest`   — incoming minor matches the current latest in
 *                        `versions.ts` → edit `index.mdx` and bump the
 *                        manifest's stored patch.
 *   - `patch-archived` — incoming minor is an older series → edit the
 *                        permanent `v<X.Y>.x.mdx` page in place. No
 *                        rename. The manifest's `latest` is unchanged.
 *
 * Usage:
 *   bun run scripts/release-version-patch.ts <X.Y.Z>
 */

import {
  RELEASE_NOTES_DIR,
  fileExists,
  parseVersion,
  readLatestFromVersionsTs,
  resolveSeriesSibling,
  runStep,
  sameMinor,
  seriesFileName,
} from "./lib/release-shared.js";
import * as path from "path";

export async function releasePatch(newVersion: string) {
  const parsed = parseVersion(newVersion);
  if (parsed.patch < 1) {
    throw new Error(
      `release-version-patch requires X.Y.Z with Z >= 1 (got v${newVersion}). ` +
        `Use release-version-minor.ts for X.Y.0.`,
    );
  }

  const incoming = `v${newVersion}`;
  const latestRaw = readLatestFromVersionsTs();
  if (!latestRaw) {
    throw new Error(
      `Could not read \`latest\` from src/lib/versions.ts. ` +
        `Patch releases need an existing manifest to compare against.`,
    );
  }
  const latest = parseVersion(latestRaw);

  console.log(`📦 Releasing docs ${incoming} (patch)`);
  console.log(`   Latest in manifest: v${latest.major}.${latest.minor}.${latest.patch}`);
  console.log(`   Incoming:           ${incoming}`);

  if (sameMinor(parsed, latest)) {
    await runPatchLatest(newVersion);
  } else {
    await runPatchArchived(newVersion, parsed.major, parsed.minor);
  }

  console.log(`\n✅ Release ${incoming} complete (patch)`);
}

async function runPatchLatest(newVersion: string) {
  console.log(`\n🎯 Mode: patch-latest (incoming minor matches current latest)`);

  const rnIndex = path.join(RELEASE_NOTES_DIR, "index.mdx");
  if (!(await fileExists(rnIndex))) {
    throw new Error(
      `Release notes index.mdx missing: ${rnIndex}\n` +
        `patch-latest must run after the minor has been released.`,
    );
  }

  runStep(
    `1️⃣  Appending v${newVersion} section to release notes (after the minor block)...`,
    `bun run scripts/generate-release-notes.ts ${newVersion} --latest --append-patch`,
  );

  runStep(
    `2️⃣  Updating versions list (latest=${newVersion})...`,
    `bun run scripts/update-versions-list.ts --latest=${newVersion}`,
  );
}

async function runPatchArchived(
  newVersion: string,
  major: number,
  minor: number,
) {
  console.log(
    `\n🎯 Mode: patch-archived (incoming minor v${major}.${minor} is archived)`,
  );

  const seriesFile = seriesFileName(major, minor);
  const targetName = await resolveSeriesSibling(RELEASE_NOTES_DIR, major, minor);
  if (!targetName) {
    throw new Error(
      `No release-notes page found for v${major}.${minor}.x under ${RELEASE_NOTES_DIR}.\n` +
        `Expected ${seriesFile} (or a legacy full-semver sibling). The minor was never released — ` +
        `there is no prior page to update.`,
    );
  }

  if (targetName !== seriesFile) {
    console.log(
      `   Note: writing to legacy sibling ${targetName} (pre-series-migration). ` +
        `The next minor release will rename it to ${seriesFile}.`,
    );
  }

  runStep(
    `1️⃣  Inserting v${newVersion} section into ${targetName} (after the minor block)...`,
    `bun run scripts/generate-release-notes.ts ${newVersion} --target=${targetName} --append-patch`,
  );

  // No --latest here: this patch sits on an archived minor, so the
  // manifest `latest` must remain unchanged. The discoverer picks up
  // the series sibling from disk.
  runStep(
    `2️⃣  Updating versions list (preserving current latest)...`,
    `bun run scripts/update-versions-list.ts`,
  );
}

// CLI — only runs when this module is invoked directly (not when imported
// by `release-version.ts` for dispatch). `import.meta.main` is true under
// both Bun and Node 24+.
if (import.meta.main) {
  const args = process.argv.slice(2);
  const versionArg = args.find((a) => !a.startsWith("--"));

  if (!versionArg || args.includes("--help") || args.includes("-h")) {
    console.log("Usage: bun run scripts/release-version-patch.ts <X.Y.Z>");
    console.log("");
    console.log(
      "Releases a patch (X.Y.Z with Z >= 1). Detects at runtime whether the",
    );
    console.log(
      "incoming minor matches the current latest (patch-latest) or is an",
    );
    console.log("archived minor (patch-archived) and adapts the flow.");
    console.log("");
    console.log("Both modes:");
    console.log(
      "  - Insert ## v<X.Y.Z> directly after the ## v<X.Y>.0 minor block",
    );
    console.log("    of the corresponding release-notes series page.");
    console.log(
      "  - Do NOT touch the API summary page (patches don't change public API).",
    );
    process.exit(versionArg ? 0 : 1);
  }

  releasePatch(versionArg).catch((err) => {
    console.error(`❌ Release (patch) failed: ${err.message}`);
    process.exit(1);
  });
}
