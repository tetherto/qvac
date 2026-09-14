#!/usr/bin/env bun
/**
 * Orchestrator for **minor** docs releases (`X.Y.0`).
 *
 * Under the shim-based layout (see the "versioned docs reorg" design
 * doc), each section's `index.mdx` is a fixed template that `<include>`s
 * the versioned MDX of the current latest series. Rotating latest
 * therefore means:
 *   - Generating the incoming series' versioned file
 *     (`v<X.Y>.x.mdx`) with the same content generators that patch and
 *     archived flows use — so every series page on disk is produced
 *     the same way, regardless of whether it happens to be latest.
 *   - Rewriting the two shim `index.mdx` files (API + release notes)
 *     to point at the new series file and advertise the new
 *     "(latest)" label + description range.
 *   - Refreshing the managed `latest-series alias` block in
 *     `public/_redirects` so the incoming series' versioned URL 301s
 *     to the canonical bare path (search engines see one canonical URL
 *     per series; the shim is the single entry point for "(latest)").
 *   - Rebuilding `src/lib/versions.ts` from disk so the selector
 *     dropdown reflects what's on-disk with the correct `(latest)`
 *     marker.
 *
 * Nothing is frozen or renamed anymore — the outgoing series' MDX file
 * is untouched (it already exists as `v<outgoing>.x.mdx` on disk, since
 * every series has always lived there under the new layout). No
 * title-only relabel is needed either: versioned MDX titles never
 * carry the "(latest)" marker; the marker lives exclusively on the
 * shim.
 *
 * No git commit / push. The wrapping workflow stages and PRs the diff.
 *
 * Usage:
 *   bun run scripts/release-version-minor.ts <X.Y.0> [--force-extract]
 */

import {
  API_DIR,
  RELEASE_NOTES_DIR,
  fileExists,
  parseVersion,
  readFrontmatterField,
  readLatestFromVersionsTs,
  runStep,
  seriesFileName,
  seriesName,
  writeLatestSeriesAliasRedirects,
  writeShim,
} from "./lib/release-shared.js";
import * as path from "path";

export interface MinorOptions {
  forceExtract: boolean;
}

export async function releaseMinor(newVersion: string, options: MinorOptions) {
  const parsed = parseVersion(newVersion);
  if (parsed.patch !== 0) {
    throw new Error(
      `release-version-minor requires X.Y.0 (got v${newVersion}). ` +
        `Use release-version-patch.ts for X.Y.${parsed.patch}.`,
    );
  }

  const incoming = `v${newVersion}`;
  const incomingSeries = seriesName(parsed);
  const outgoing = readLatestFromVersionsTs();

  console.log(`📦 Releasing docs ${incoming} (minor)`);
  console.log(`   Outgoing: ${outgoing ?? "(unknown)"}`);
  console.log(`   Incoming: ${incoming}`);

  if (outgoing && outgoing === incoming) {
    throw new Error(
      `New version ${incoming} is already the current latest. Nothing to do.`,
    );
  }

  // Fail-fast pre-flight: the shim rewrites below are only safe if the
  // outgoing series' versioned page still exists on disk. Under the
  // shim-based layout that file is the only surviving copy of the
  // outgoing series' content — the old freeze-and-rename dance is gone,
  // so nothing else in this flow re-creates it. If it's absent (rolled-
  // back release, hand-edited tree, accidental deletion, partial
  // checkout), the shims would silently repoint to the incoming series
  // and the outgoing series page would drop off the site with no diff
  // that looks wrong — until someone hits a 404 weeks later. Turn that
  // silent regression into a hard failure that refuses to rotate.
  if (outgoing) {
    const out = parseVersion(outgoing);
    for (const dir of [API_DIR, RELEASE_NOTES_DIR]) {
      const f = path.join(dir, seriesFileName(out.major, out.minor));
      if (!(await fileExists(f))) {
        throw new Error(
          `Outgoing series page missing: ${f} — rotating the shim would orphan v${out.major}.${out.minor}.x.`,
        );
      }
    }
  }

  const apiFlags: string[] = [];
  if (options.forceExtract) apiFlags.push("--force-extract");

  runStep(
    `1️⃣  Generating ${incoming} API summary → ${seriesFileName(parsed.major, parsed.minor)}...`,
    `bun run scripts/generate-api-docs.ts ${newVersion}${apiFlags.length ? " " + apiFlags.join(" ") : ""}`,
  );

  runStep(
    `2️⃣  Generating ${incoming} release notes → ${seriesFileName(parsed.major, parsed.minor)} (Fonte B: per-version folder)...`,
    `bun run scripts/generate-release-notes.ts ${newVersion}`,
  );

  // Mirror the versioned page's freshly-written description onto the
  // shim so the canonical bare URL and the versioned URL always ship
  // the same meta description. Keeping the string in one place (the
  // template that produced the versioned file) avoids the silent drift
  // that hardcoding it here would eventually cause — same trick
  // `patch-latest` uses for the release-notes shim.
  const apiSeriesPath = path.join(
    API_DIR,
    seriesFileName(parsed.major, parsed.minor),
  );
  const apiDescription = await readFrontmatterField(apiSeriesPath, "description");
  if (!apiDescription) {
    throw new Error(
      `API summary description missing from ${apiSeriesPath}. ` +
        `generate-api-docs.ts must write a frontmatter description for the shim to mirror.`,
    );
  }

  console.log(
    `\n3️⃣  Rewriting API summary shim to <include> ${seriesFileName(parsed.major, parsed.minor)}...`,
  );
  await writeShim(
    API_DIR,
    seriesFileName(parsed.major, parsed.minor),
    `API Summary — ${incomingSeries} (latest)`,
    apiDescription,
  );

  console.log(
    `\n4️⃣  Rewriting release-notes shim to <include> ${seriesFileName(parsed.major, parsed.minor)}...`,
  );
  await writeShim(
    RELEASE_NOTES_DIR,
    seriesFileName(parsed.major, parsed.minor),
    `SDK Release Notes — ${incomingSeries} (latest)`,
    `Release notes for QVAC SDK v${newVersion}.`,
  );

  console.log(
    `\n5️⃣  Rewriting latest-series alias block in _redirects (${incomingSeries})...`,
  );
  await writeLatestSeriesAliasRedirects(incomingSeries);

  runStep(
    `6️⃣  Updating versions list...`,
    `bun run scripts/update-versions-list.ts --latest=${newVersion}`,
  );

  console.log(`\n✅ Release ${incoming} complete (minor)`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const versionArg = args.find((a) => !a.startsWith("--"));
  const forceExtract = args.includes("--force-extract");

  if (!versionArg || args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: bun run scripts/release-version-minor.ts <X.Y.0> [--force-extract]",
    );
    console.log("");
    console.log("Rotates the docs latest to the incoming minor:");
    console.log(
      "  - Generates the versioned MDX for API + release notes at v<X.Y>.x.mdx.",
    );
    console.log(
      "  - Rewrites both index.mdx shims to <include> the new series file.",
    );
    console.log(
      "  - Refreshes the latest-series alias block in public/_redirects.",
    );
    console.log("  - Refreshes src/lib/versions.ts.");
    console.log("");
    console.log("Flags:");
    console.log(
      "  --force-extract   Bypass mtime cache and re-run TypeDoc extraction.",
    );
    process.exit(versionArg ? 0 : 1);
  }

  releaseMinor(versionArg, { forceExtract }).catch((err) => {
    console.error(`❌ Release (minor) failed: ${err.message}`);
    process.exit(1);
  });
}
