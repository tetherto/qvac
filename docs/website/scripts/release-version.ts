#!/usr/bin/env bun
/**
 * Unified docs release dispatcher. Auto-detects whether the incoming
 * version is a minor (`X.Y.0`) or a patch (`X.Y.Z`, `Z >= 1`) and calls
 * the appropriate orchestrator.
 *
 * The minor and patch flows have very different effects (full freeze +
 * regenerate vs. title-only + append-patch), but from the workflow's
 * perspective they share the same wrapper steps (label-gate, dual
 * checkout, link-integrity tests, PR open). A single entry point keeps
 * the GitHub workflow simple while preserving the per-flow invariants
 * inside the existing `release-version-{minor,patch}.ts` modules.
 *
 * The `--force-extract` flag is accepted for both flows; it is a no-op
 * in the patch flow (which never re-runs TypeDoc) but the workflow
 * passes it unconditionally for uniformity.
 *
 * Usage:
 *   bun run scripts/release-version.ts <X.Y.Z> [--force-extract]
 */

import { parseVersion } from "./lib/release-shared.js";
import { releaseMinor } from "./release-version-minor.js";
import { releasePatch } from "./release-version-patch.js";

async function dispatch(newVersion: string, forceExtract: boolean) {
  const parsed = parseVersion(newVersion);
  if (parsed.patch === 0) {
    await releaseMinor(newVersion, { forceExtract });
  } else {
    await releasePatch(newVersion);
  }
}

const args = process.argv.slice(2);
const versionArg = args.find((a) => !a.startsWith("--"));
const forceExtract = args.includes("--force-extract");

if (!versionArg || args.includes("--help") || args.includes("-h")) {
  console.log(
    "Usage: bun run scripts/release-version.ts <X.Y.Z> [--force-extract]",
  );
  console.log("");
  console.log(
    "Auto-detects minor (X.Y.0) vs patch (X.Y.Z, Z>=1) from the version",
  );
  console.log(
    "and runs the appropriate orchestrator. Wraps the existing focused",
  );
  console.log("`release-version-minor.ts` / `release-version-patch.ts` modules.");
  console.log("");
  console.log("Flags:");
  console.log(
    "  --force-extract   Bypass mtime cache and re-run TypeDoc extraction",
  );
  console.log("                    (minor only; ignored on patch).");
  process.exit(versionArg ? 0 : 1);
}

dispatch(versionArg, forceExtract).catch((err) => {
  console.error(`❌ Release failed: ${err.message}`);
  process.exit(1);
});
