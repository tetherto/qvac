#!/usr/bin/env bun
/**
 * Orchestrator for **minor** docs releases (`X.Y.0`).
 *
 * Invariants enforced here:
 *   - Incoming version must end in `.0` (defensive: the workflow's branch
 *     glob already guarantees this, but local invocations could violate
 *     it).
 *   - The current latest (read from `versions.ts`) is frozen as a sibling
 *     `vX.Y.Z.mdx` before any new content is generated, so the version
 *     selector never loses the outgoing snapshot.
 *
 * Steps (each delegated to the existing focused scripts):
 *   1. `create-version-bundle.ts <outgoing>` — copies `index.mdx` into a
 *      `v<outgoing>.mdx` sibling for both API and release-notes sections.
 *  1a. `generate-api-docs.ts <outgoing> --target=v<outgoing>.mdx --title-only`
 *  1b. `generate-release-notes.ts <outgoing> --target=v<outgoing>.mdx --title-only`
 *      The freeze in step 1 is a raw file copy, so each snapshot inherits
 *      the outgoing `index.mdx` title verbatim — which still advertises
 *      `(latest)` and may carry a stale version label. Steps 1a / 1b
 *      relabel the snapshots to the canonical archived form (`vX.Y.Z`
 *      without `(latest)`) without re-rendering their bodies.
 *   2. `generate-api-docs.ts <new> --latest --no-ai` — runs TypeDoc + render
 *      and writes the new `index.mdx`. The release pipeline always passes
 *      `--no-ai`: AI augmentation is intentionally not part of this
 *      pipeline (it produces non-deterministic output and forces extra
 *      review). The standalone `generate-api-docs.ts` script still
 *      supports AI for ad-hoc manual runs.
 *   3. `generate-release-notes.ts <new> --latest` — reads the per-version
 *      changelog folder (Fonte B: `packages/sdk/changelog/<new>/CHANGELOG_LLM.md`)
 *      and writes the new `index.mdx`. No `--aggregate-minor` here because
 *      a fresh minor has exactly one folder.
 *   4. `update-versions-list.ts --latest=<new>` — refreshes `versions.ts`
 *      from disk.
 *
 * No git commit / push. The wrapping workflow stages and PRs the diff.
 *
 * Usage:
 *   bun run scripts/release-version-minor.ts <X.Y.0> [--force-extract]
 */

import {
  API_DIR,
  fileExists,
  parseVersion,
  readLatestFromVersionsTs,
  runStep,
} from "./lib/release-shared.js";
import * as path from "path";

interface MinorOptions {
  forceExtract: boolean;
}

async function releaseMinor(newVersion: string, options: MinorOptions) {
  const parsed = parseVersion(newVersion);
  if (parsed.patch !== 0) {
    throw new Error(
      `release-version-minor requires X.Y.0 (got v${newVersion}). ` +
        `Use release-version-patch.ts for X.Y.${parsed.patch}.`,
    );
  }

  const incoming = `v${newVersion}`;
  const outgoing = readLatestFromVersionsTs();

  console.log(`📦 Releasing docs ${incoming} (minor)`);
  console.log(`   Outgoing: ${outgoing ?? "(unknown)"}`);
  console.log(`   Incoming: ${incoming}`);

  if (outgoing && outgoing === incoming) {
    throw new Error(
      `New version ${incoming} is already the current latest. Nothing to do.`,
    );
  }

  // Sanity-check the index file we're about to freeze. Missing index.mdx
  // means either the path is wrong (regression) or a prior release was
  // interrupted — either way, fail fast rather than corrupt the manifest.
  const apiIndex = path.join(API_DIR, "index.mdx");
  if (!(await fileExists(apiIndex))) {
    throw new Error(
      `API summary index missing: ${apiIndex}\n` +
        `Run a prior release-version-minor end-to-end or restore the file before retrying.`,
    );
  }

  if (outgoing) {
    const outgoingNumeric = outgoing.replace(/^v/, "");
    runStep(
      `1️⃣  Freezing outgoing ${outgoing}...`,
      `bun run scripts/create-version-bundle.ts ${outgoingNumeric}`,
    );

    // The freeze above is a raw `fs.copyFile` of `index.mdx` into the
    // sibling snapshot, so the snapshot inherits the outgoing index's
    // frontmatter title verbatim. That title still advertises the
    // outgoing as `(latest)` and may even carry a stale version label
    // (e.g. when the index was hand-edited between releases). Relabel
    // both snapshots to the canonical archived form (`vX.Y.Z`, no
    // `(latest)`) using the dedicated title-only mode so the body is
    // preserved byte-for-byte.
    const snapshotTarget = `v${outgoingNumeric}.mdx`;
    runStep(
      `1️⃣a Relabeling archived API snapshot title (${snapshotTarget})...`,
      `bun run scripts/generate-api-docs.ts ${outgoingNumeric} --target=${snapshotTarget} --title-only`,
    );
    runStep(
      `1️⃣b Relabeling archived release-notes snapshot title (${snapshotTarget})...`,
      `bun run scripts/generate-release-notes.ts ${outgoingNumeric} --target=${snapshotTarget} --title-only`,
    );
  } else {
    console.log(
      `\n1️⃣  Skipping freeze step (no previous latest detected in versions.ts).`,
    );
  }

  // Pipeline-level decision: never run AI augmentation. Keeps CI output
  // deterministic and removes the LLM secret/PAT surface from this flow.
  // The standalone generate-api-docs.ts script still supports AI for
  // ad-hoc manual runs.
  const apiFlags: string[] = ["--latest", "--no-ai"];
  if (options.forceExtract) apiFlags.push("--force-extract");

  runStep(
    `2️⃣  Generating ${incoming} API summary...`,
    `bun run scripts/generate-api-docs.ts ${newVersion} ${apiFlags.join(" ")}`,
  );

  // Per-minor reads the per-version changelog folder (Fonte B). No
  // `--aggregate-minor` flag: a fresh minor has exactly one folder
  // (X.Y.0) at this point — there are no patches to roll up yet.
  runStep(
    `3️⃣  Generating ${incoming} release notes (Fonte B: per-version folder)...`,
    `bun run scripts/generate-release-notes.ts ${newVersion} --latest`,
  );

  runStep(
    `4️⃣  Updating versions list...`,
    `bun run scripts/update-versions-list.ts --latest=${newVersion}`,
  );

  console.log(`\n✅ Release ${incoming} complete (minor)`);
}

const args = process.argv.slice(2);
const versionArg = args.find((a) => !a.startsWith("--"));
const forceExtract = args.includes("--force-extract");

if (!versionArg || args.includes("--help") || args.includes("-h")) {
  console.log(
    "Usage: bun run scripts/release-version-minor.ts <X.Y.0> [--force-extract]",
  );
  console.log("");
  console.log("Promotes a minor release to latest:");
  console.log(
    "  - Freezes the outgoing latest as vX.Y.Z.mdx for both API + release notes.",
  );
  console.log(
    "  - Generates new API summary + release notes (Fonte B per-version folder).",
  );
  console.log("  - Refreshes src/lib/versions.ts.");
  console.log("");
  console.log("Flags:");
  console.log(
    "  --force-extract   Bypass mtime cache and re-run TypeDoc extraction.",
  );
  console.log("");
  console.log(
    "AI augmentation is intentionally not exposed here — the pipeline always",
  );
  console.log(
    "passes --no-ai to generate-api-docs.ts. Use that script directly for",
  );
  console.log("ad-hoc runs that want AI.");
  process.exit(versionArg ? 0 : 1);
}

releaseMinor(versionArg, { forceExtract }).catch((err) => {
  console.error(`❌ Release (minor) failed: ${err.message}`);
  process.exit(1);
});
