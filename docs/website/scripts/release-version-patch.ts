#!/usr/bin/env bun
/**
 * Orchestrator for **patch** docs releases (`X.Y.Z` with `Z >= 1`).
 *
 * Per the shim-based versioning model:
 *
 *   - **API summary is NOT touched by patches.** Patches by definition
 *     don't add new public API surface (that would be a minor), so
 *     both the API series page `v<X.Y>.x.mdx` and the API shim
 *     `index.mdx` stay as they were after the minor release.
 *   - **Release notes accumulate patch sections** under the series
 *     page `v<X.Y>.x.mdx`. Each patch inserts its `## v<X.Y.Z>` section
 *     directly after the `## v<X.Y>.0` minor block, so the most recent
 *     patches sit right under the minor.
 *   - **When the patch targets the current latest series**, we also
 *     mirror the versioned file's updated `description:` line onto
 *     the shim `index.mdx` so the advertised "Lists all releases from
 *     … to …" range stays truthful for the canonical bare URL.
 *
 * Mode selection happens at runtime:
 *   - `patch-latest`   — incoming minor matches the current latest in
 *                        `versions.ts` → edit `v<X.Y>.x.mdx` (the
 *                        series page the shim `<include>`s), then
 *                        mirror its new description onto the shim
 *                        and bump the manifest's stored patch.
 *   - `patch-archived` — incoming minor is an older series → edit the
 *                        permanent `v<X.Y>.x.mdx` page in place. No
 *                        rename. No shim touch (the shim points at
 *                        the latest series, not this one). The
 *                        manifest's `latest` is unchanged.
 *
 * Usage:
 *   bun run scripts/release-version-patch.ts <X.Y.Z>
 */

import {
  RELEASE_NOTES_DIR,
  fileExists,
  parseVersion,
  readFrontmatterField,
  readLatestFromVersionsTs,
  resolveSeriesSibling,
  rewriteFrontmatterDescriptionLine,
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
    await runPatchLatest(newVersion, parsed.major, parsed.minor);
  } else {
    await runPatchArchived(newVersion, parsed.major, parsed.minor);
  }

  console.log(`\n✅ Release ${incoming} complete (patch)`);
}

async function runPatchLatest(
  newVersion: string,
  major: number,
  minor: number,
) {
  console.log(`\n🎯 Mode: patch-latest (incoming minor matches current latest)`);

  const seriesFile = seriesFileName(major, minor);
  const seriesPath = path.join(RELEASE_NOTES_DIR, seriesFile);
  if (!(await fileExists(seriesPath))) {
    throw new Error(
      `Release notes series page missing: ${seriesPath}\n` +
        `patch-latest must run after the minor has been released.`,
    );
  }

  runStep(
    `1️⃣  Inserting v${newVersion} section into ${seriesFile} (after the minor block)...`,
    `bun run scripts/generate-release-notes.ts ${newVersion} --target=${seriesFile} --append-patch`,
  );

  // Mirror the versioned page's freshly-computed description ("Lists
  // all releases from …") onto the shim so the canonical bare URL
  // advertises the same range as the versioned URL. The API shim's
  // description is static (patches don't touch API), so we only sync
  // release-notes here.
  const seriesDescription = await readFrontmatterField(seriesPath, "description");
  if (seriesDescription) {
    const shimPath = path.join(RELEASE_NOTES_DIR, "index.mdx");
    console.log(
      `\n2️⃣  Mirroring versioned description onto release-notes shim...`,
    );
    console.log(`   ${seriesDescription}`);
    await rewriteFrontmatterDescriptionLine(shimPath, seriesDescription);
  }

  runStep(
    `3️⃣  Updating versions list (latest=${newVersion})...`,
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
  // the series sibling from disk. The shim is not touched — it points
  // at the current latest series, not this archived one.
  runStep(
    `2️⃣  Updating versions list (preserving current latest)...`,
    `bun run scripts/update-versions-list.ts`,
  );
}

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
    console.log(
      "  - patch-latest also mirrors the versioned page's description onto",
    );
    console.log("    the release-notes shim so the canonical URL stays truthful.");
    process.exit(versionArg ? 0 : 1);
  }

  releasePatch(versionArg).catch((err) => {
    console.error(`❌ Release (patch) failed: ${err.message}`);
    process.exit(1);
  });
}
