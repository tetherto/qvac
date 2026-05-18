#!/usr/bin/env bun
/**
 * Orchestrator for **patch** docs releases (`X.Y.Z` with `Z >= 1`).
 *
 * Runtime branch decision (`patch-latest` vs `patch-archived`):
 *   - Read the current `latest` semver from `src/lib/versions.ts`.
 *   - If `incoming.major === latest.major && incoming.minor === latest.minor`
 *     then we are bumping the current latest minor — write to `index.mdx`.
 *     This is `patch-latest`.
 *   - Otherwise the patch targets a previously-archived minor — we need to
 *     rename `v<previous patch>.mdx` to `v<new>.mdx` and edit the renamed
 *     file. This is `patch-archived`.
 *
 * Per the planning decision:
 *   - API summary is NOT regenerated from TypeDoc — only the frontmatter
 *     `title` is bumped to the new version. Patches must not introduce new
 *     public APIs (that would be a minor by definition).
 *   - Release notes get a fresh `## v<new>` section APPENDED at the bottom
 *     of the existing page, so the cumulative minor narrative stays intact.
 *
 * Steps:
 *   patch-latest:
 *     1. `generate-api-docs.ts <new> --latest --title-only`
 *     2. `generate-release-notes.ts <new> --latest --append-patch`
 *     3. `update-versions-list.ts --latest=<new>`
 *
 *   patch-archived:
 *     1. Resolve `v<old patch>.mdx` siblings under `api/` and
 *        `release-notes/` (newest patch wins for idempotency).
 *     2. `git mv` each to `v<new>.mdx`.
 *     3. `generate-api-docs.ts <new> --target=v<new>.mdx --title-only`
 *     4. `generate-release-notes.ts <new> --target=v<new>.mdx --append-patch`
 *     5. `update-versions-list.ts` (no `--latest` flag — discoverer picks
 *        the new sibling from disk; the latest minor is unchanged).
 *
 * Usage:
 *   bun run scripts/release-version-patch.ts <X.Y.Z>
 */

import {
  API_DIR,
  DOCS_WEBSITE_DIR,
  RELEASE_NOTES_DIR,
  fileExists,
  gitMove,
  parseVersion,
  readLatestFromVersionsTs,
  resolveArchivedSibling,
  runStep,
  sameMinor,
} from "./lib/release-shared.js";
import * as path from "path";

async function releasePatch(newVersion: string) {
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

  const apiIndex = path.join(API_DIR, "index.mdx");
  const rnIndex = path.join(RELEASE_NOTES_DIR, "index.mdx");
  if (!(await fileExists(apiIndex))) {
    throw new Error(
      `API index.mdx missing: ${apiIndex}\n` +
        `patch-latest must run after the minor has been released.`,
    );
  }
  if (!(await fileExists(rnIndex))) {
    throw new Error(
      `Release notes index.mdx missing: ${rnIndex}\n` +
        `patch-latest must run after the minor has been released.`,
    );
  }

  runStep(
    `1️⃣  Updating API summary title only (no TypeDoc rerun)...`,
    `bun run scripts/generate-api-docs.ts ${newVersion} --latest --title-only`,
  );

  runStep(
    `2️⃣  Appending v${newVersion} section to release notes...`,
    `bun run scripts/generate-release-notes.ts ${newVersion} --latest --append-patch`,
  );

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

  const oldApiName = await resolveArchivedSibling(API_DIR, major, minor);
  const oldRnName = await resolveArchivedSibling(RELEASE_NOTES_DIR, major, minor);
  if (!oldApiName && !oldRnName) {
    throw new Error(
      `No archived sibling found for v${major}.${minor}.* under either ` +
        `${API_DIR} or ${RELEASE_NOTES_DIR}. There is no prior patch of this minor ` +
        `to update — the minor was never released.`,
    );
  }

  const newName = `v${newVersion}.mdx`;

  // Pass paths relative to DOCS_WEBSITE_DIR so the `git mv` output stays
  // anchored to the docs subtree (matters when the workflow inspects the
  // PR diff path-by-path) and `gitMove` works the same locally and in CI.
  const apiRel = path.relative(DOCS_WEBSITE_DIR, API_DIR);
  const rnRel = path.relative(DOCS_WEBSITE_DIR, RELEASE_NOTES_DIR);

  if (oldApiName && oldApiName !== newName) {
    console.log(
      `\n1️⃣a Renaming archived API sibling ${oldApiName} → ${newName}...`,
    );
    await gitMove(
      path.join(apiRel, oldApiName),
      path.join(apiRel, newName),
    );
  } else if (oldApiName === newName) {
    console.log(
      `\n1️⃣a API sibling already named ${newName} — skipping rename (idempotent).`,
    );
  } else {
    console.log(
      `\n1️⃣a No archived API sibling for v${major}.${minor}.* — skipping rename.`,
    );
  }

  if (oldRnName && oldRnName !== newName) {
    console.log(
      `\n1️⃣b Renaming archived release-notes sibling ${oldRnName} → ${newName}...`,
    );
    await gitMove(
      path.join(rnRel, oldRnName),
      path.join(rnRel, newName),
    );
  } else if (oldRnName === newName) {
    console.log(
      `\n1️⃣b Release notes sibling already named ${newName} — skipping rename.`,
    );
  } else {
    console.log(
      `\n1️⃣b No archived release-notes sibling for v${major}.${minor}.* — skipping rename.`,
    );
  }

  if (oldApiName) {
    runStep(
      `2️⃣  Updating API summary title only (no TypeDoc rerun)...`,
      `bun run scripts/generate-api-docs.ts ${newVersion} --target=${newName} --title-only`,
    );
  }

  if (oldRnName) {
    runStep(
      `3️⃣  Appending v${newVersion} section to renamed release notes...`,
      `bun run scripts/generate-release-notes.ts ${newVersion} --target=${newName} --append-patch`,
    );
  }

  // No --latest here: this patch sits on an archived minor, so the manifest
  // `latest` must remain unchanged. The discoverer will pick up the renamed
  // sibling from disk.
  runStep(
    `4️⃣  Updating versions list (preserving current latest)...`,
    `bun run scripts/update-versions-list.ts`,
  );
}

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
  console.log(
    "patch-latest:    edits index.mdx (title-only API + append-patch RN).",
  );
  console.log(
    "patch-archived:  git mv v<old>.mdx -> v<new>.mdx, then edits in place.",
  );
  process.exit(versionArg ? 0 : 1);
}

releasePatch(versionArg).catch((err) => {
  console.error(`❌ Release (patch) failed: ${err.message}`);
  process.exit(1);
});
