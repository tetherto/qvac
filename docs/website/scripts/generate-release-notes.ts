#!/usr/bin/env bun
/**
 * Generate (or augment) the per-minor-series release-notes MDX page for
 * the SDK pod.
 *
 * Page model
 * ----------
 * Each minor line has a single permanent MDX page that accumulates patch
 * sections as `## vX.Y.Z` blocks:
 *
 *   - latest minor series → `content/docs/reference/release-notes/index.mdx`
 *   - older minor series  → `content/docs/reference/release-notes/v<X.Y>.x.mdx`
 *
 * The `## vX.Y.0` block is written by the minor release; subsequent
 * patches insert their `## vX.Y.Z` section directly after the minor
 * block (newest patch right under the minor, older patches further
 * down). The page is never deleted — it is the canonical "history of
 * that minor line".
 *
 * Per-version content
 * -------------------
 * Each `## vX.Y.Z` block contains one `### @qvac/<pkg>` subsection per
 * SDK pod package. The subsection body is the **verbatim**
 * `CHANGELOG_LLM.md` of that package's `changelog/<version>/` folder,
 * with the leading H1 (`# QVAC SDK v… Release Notes`) stripped and all
 * surviving heading levels demoted so they nest under the per-package
 * H3.
 *
 * Modes
 * -----
 * - **default** (minor release): full render. Writes the page from
 *   scratch with `## v<X.Y.0>` as the only version block.
 * - **`--append-patch`** (patch release): renders only the per-version
 *   block and inserts it directly after the existing `## v<X.Y>.0`
 *   block. Also rewrites the frontmatter `description:` line to update
 *   the upper-bound patch in the "Lists all releases from v0.X.0 to
 *   v0.X.<N>" range. Re-running with the same patch is idempotent —
 *   the existing section is replaced in place.
 * - **`--title-only`**: rewrites only the frontmatter `title:` line of
 *   the existing target MDX. Used by the minor orchestrator to relabel
 *   a freshly-frozen series snapshot from `vX.Y.x (latest)` to plain
 *   `vX.Y.x` without touching the body.
 *
 * Targets
 * -------
 * - `--latest`: write to `index.mdx`
 * - `--target=<file>`: write to `release-notes/<file>` (used by the
 *   patch-archived flow to address `vX.Y.x.mdx`)
 * - otherwise: default to the series-named sibling
 *   `vX.Y.x.mdx` derived from the version arg
 *
 * Usage:
 *   bun run scripts/generate-release-notes.ts <version> [flags]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import nunjucks from "nunjucks";
import {
  readChangelogLLMVerbatim,
  parseOverridesContent,
  escapeRegExp,
  type VerbatimChangelog,
  type OverrideSection,
} from "./lib/changelog-parser";
import {
  parseVersion,
  rewriteFrontmatterTitleLine,
  seriesFileName,
  seriesName,
} from "./lib/release-shared.js";

const SDK_POD_PACKAGES = ["sdk", "cli", "rag", "logging", "error"] as const;

function parseOverrides(filePath: string): OverrideSection[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8");
  return parseOverridesContent(content);
}

/**
 * Inspect an existing release-notes page and pull every `## vX.Y.Z`
 * heading into a sorted patch list. Used by the patch flow to recompute
 * the "Lists all releases from … to …" description.
 *
 * `series` is `vX.Y.x` — the regex anchors on `X.Y` so headings from a
 * stray different-minor entry are ignored.
 */
function listPatchHeadingsInFile(filePath: string, series: string): string[] {
  if (!existsSync(filePath)) return [];
  const match = /^v(\d+)\.(\d+)\.x$/.exec(series);
  if (!match) return [];
  const [, major, minor] = match;
  const re = new RegExp(
    `^##\\s+v${escapeRegExp(major)}\\.${escapeRegExp(minor)}\\.(\\d+)\\b`,
    "gm",
  );
  const versions = new Set<string>();
  const content = readFileSync(filePath, "utf-8");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    versions.add(`v${major}.${minor}.${m[1]}`);
  }
  return Array.from(versions).sort((a, b) => {
    const ap = parseInt(a.split(".")[2], 10);
    const bp = parseInt(b.split(".")[2], 10);
    return ap - bp;
  });
}

/**
 * Recompute the description line "Lists all releases from v0.X.0 to
 * v0.X.<latestPatch>" from the patch headings present in `pageContent`.
 * `incomingPatch` is included even when not yet inlined (the caller
 * inserts/replaces the section right after this).
 */
function describeReleaseRange(
  patches: string[],
  series: string,
): string {
  if (patches.length === 0) {
    // No patches yet — minor release page. Describe just the minor.
    const minorOnly = series.replace(/\.x$/, ".0");
    return `Release notes for QVAC SDK ${minorOnly}.`;
  }
  if (patches.length === 1) {
    return `Release notes for QVAC SDK ${patches[0]}.`;
  }
  return `Lists all releases from ${patches[0]} to ${patches[patches.length - 1]}.`;
}

/**
 * Locate the existing `## v<series-minor>.0` block inside an existing
 * series page, then return the byte offset immediately after that
 * block's content. Insertion at that offset places the new patch
 * section directly under the minor — newest-first below the minor line.
 *
 * The block is defined as: the heading line, plus every subsequent line
 * up to (but not including) the next `## v…` heading or EOF.
 */
function findInsertionAfterMinor(
  content: string,
  series: string,
): { offset: number; minorIndex: number } | null {
  const match = /^v(\d+)\.(\d+)\.x$/.exec(series);
  if (!match) return null;
  const [, major, minor] = match;
  const minorHeading = `## v${major}.${minor}.0`;
  const lines = content.split("\n");
  let minorLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === minorHeading) {
      minorLineIdx = i;
      break;
    }
  }
  if (minorLineIdx < 0) return null;

  // Find the next `## v` heading after the minor (any patch / unrelated
  // minor heading both count). Failing that, run to EOF.
  let nextIdx = lines.length;
  const versionHeadingRe = /^##\s+v\d+\.\d+\.\d+\b/;
  for (let i = minorLineIdx + 1; i < lines.length; i++) {
    if (versionHeadingRe.test(lines[i])) {
      nextIdx = i;
      break;
    }
  }

  const head = lines.slice(0, nextIdx).join("\n");
  return { offset: head.length, minorIndex: minorLineIdx };
}

/**
 * Locate an existing `## v<X.Y.Z>` block by exact patch version. Used by
 * the idempotent patch flow to detect a re-run and splice the new
 * section in place instead of appending a duplicate.
 *
 * Returns `[startOffset, endOffset)` measured in chars.
 */
function findExistingPatchBlock(
  content: string,
  version: string,
): { startOffset: number; endOffset: number } | null {
  const patchHeading = `## v${version}`;
  const idx = content.indexOf(patchHeading);
  if (idx < 0) return null;
  // Require start-of-line match (avoid matching inside a fenced block
  // that quotes a heading) and that the next char is a newline /
  // whitespace, not a continuation like `0-rc1`.
  if (idx > 0 && content[idx - 1] !== "\n") return null;
  const trailing = content.charCodeAt(idx + patchHeading.length);
  // Acceptable end-of-version: newline, space, or EOF (NaN).
  if (
    !Number.isNaN(trailing) &&
    trailing !== 0x0a /* \n */ &&
    trailing !== 0x20 /* space */
  ) {
    return null;
  }
  // Walk forward to the next `## v` heading or EOF.
  const nextRe = /\n##\s+v\d+\.\d+\.\d+\b/g;
  nextRe.lastIndex = idx + patchHeading.length;
  const nextMatch = nextRe.exec(content);
  const endOffset = nextMatch ? nextMatch.index + 1 : content.length;
  return { startOffset: idx, endOffset };
}

interface PerPackageEntry {
  pkg: string;
  body: string;
}

function gatherVerbatim(
  repoRoot: string,
  version: string,
): { entries: PerPackageEntry[] } {
  const entries: PerPackageEntry[] = [];
  for (const pkg of SDK_POD_PACKAGES) {
    const folderPath = resolve(
      repoRoot,
      "packages",
      pkg,
      "changelog",
      version,
    );
    const parsed: VerbatimChangelog | null = readChangelogLLMVerbatim(
      folderPath,
      pkg,
    );
    if (!parsed) {
      console.log(
        `  Skipping @qvac/${pkg} (no changelog folder at ${folderPath})`,
      );
      continue;
    }
    console.log(`  Found v${version} folder for @qvac/${pkg}`);
    entries.push({ pkg: parsed.pkg, body: parsed.body });
  }
  return { entries };
}

async function main() {
  const args = process.argv.slice(2);
  const version = args.find((arg) => !arg.startsWith("--"));
  const isLatest = args.includes("--latest");
  const appendPatch = args.includes("--append-patch");
  const titleOnly = args.includes("--title-only");
  const targetFlag = args.find((arg) => arg.startsWith("--target="));
  const target = targetFlag ? targetFlag.slice("--target=".length) : null;

  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(
      "Usage: bun run scripts/generate-release-notes.ts <version> [--latest] [--target=<file>] [--append-patch] [--title-only]",
    );
    console.error("  version must be semver (e.g. 0.11.1)");
    process.exit(1);
  }

  if (isLatest && target) {
    console.error(
      "Error: --latest and --target=<file> are mutually exclusive.",
    );
    process.exit(1);
  }

  if (titleOnly && appendPatch) {
    console.error(
      "Error: --title-only is incompatible with --append-patch.",
    );
    process.exit(1);
  }

  const parsed = parseVersion(version);
  const series = seriesName(parsed);
  const websiteDir = process.cwd();
  const releaseNotesDir = resolve(
    websiteDir,
    "content",
    "docs",
    "reference",
    "release-notes",
  );

  // Resolve the output target. Default falls back to the series-named
  // sibling for the version's minor — generic enough that callers don't
  // need to know about the new naming convention.
  const outputPath = resolve(
    releaseNotesDir,
    target ??
      (isLatest ? "index.mdx" : seriesFileName(parsed.major, parsed.minor)),
  );

  // -------------------------------------------------------------------
  // Title-only path — relabel a freshly-frozen archived snapshot.
  // -------------------------------------------------------------------
  if (titleOnly) {
    const titleLabel = isLatest ? `${series} (latest)` : series;
    console.log(`📝 Title-only update for SDK Release Notes — ${titleLabel}...`);
    console.log(`   Target: ${outputPath}`);
    await rewriteFrontmatterTitleLine(
      outputPath,
      `SDK Release Notes — ${titleLabel}`,
    );
    console.log(`✅ Title-only update complete (${titleLabel})`);
    return;
  }

  // `CHANGELOG_REPO_ROOT` pins the changelog read at the release commit
  // so concurrent merges to `main` can't smuggle stale or future
  // CHANGELOG entries into the rendered release notes.
  const repoRoot = process.env.CHANGELOG_REPO_ROOT
    ? resolve(process.env.CHANGELOG_REPO_ROOT)
    : resolve(websiteDir, "../..");

  console.log(
    `Generating release notes for v${version} (series ${series})` +
      (appendPatch ? " [append-patch]" : "") +
      `...`,
  );
  if (process.env.CHANGELOG_REPO_ROOT) {
    console.log(`  Reading changelogs from: ${repoRoot}`);
  }
  console.log("");

  const { entries } = gatherVerbatim(repoRoot, version);
  if (entries.length === 0) {
    console.error(
      `\nNo CHANGELOG_LLM.md found for v${version} in any SDK pod package.`,
    );
    process.exit(1);
  }

  const templateDir = resolve(
    websiteDir,
    "scripts",
    "api-docs",
    "templates",
  );
  nunjucks.configure(templateDir, {
    autoescape: false,
    trimBlocks: true,
    lstripBlocks: true,
  });

  // -------------------------------------------------------------------
  // Append-patch path — insert (or replace in place) the new `## vX.Y.Z`
  // section directly after the minor `## vX.Y.0` block of the existing
  // file. Newest patch ends up right below the minor; older patches
  // remain further down.
  // -------------------------------------------------------------------
  if (appendPatch) {
    if (!existsSync(outputPath)) {
      console.error(
        `❌ --append-patch requires existing target: ${outputPath}\n` +
          `   Run the minor release first.`,
      );
      process.exit(1);
    }
    const sectionBody = nunjucks.render("release-notes-patch-section.njk", {
      version,
      packages: entries,
    });
    let existing = readFileSync(outputPath, "utf-8");

    // Idempotent re-run: if the same patch was already inserted, replace
    // its block in place. Otherwise insert at the after-minor offset.
    const replaceRange = findExistingPatchBlock(existing, version);
    if (replaceRange) {
      const before = existing.slice(0, replaceRange.startOffset).replace(/\s+$/, "");
      const after = existing.slice(replaceRange.endOffset).replace(/^\s+/, "");
      const middle = sectionBody.trim();
      existing =
        (before ? before + "\n\n" : "") +
        middle +
        (after ? "\n\n" + after : "") +
        "\n";
    } else {
      const insertion = findInsertionAfterMinor(existing, series);
      if (!insertion) {
        console.error(
          `❌ --append-patch could not find \`## v${parsed.major}.${parsed.minor}.0\` heading in ${outputPath}.\n` +
            `   The minor block must exist before patches can be inserted.`,
        );
        process.exit(1);
      }
      const before = existing.slice(0, insertion.offset).replace(/\s+$/, "");
      const after = existing.slice(insertion.offset).replace(/^\s+/, "");
      const middle = sectionBody.trim();
      existing = before + "\n\n" + middle + (after ? "\n\n" + after : "") + "\n";
    }

    // Refresh the description line with the patch range now present in
    // the file. The title-only helper would clobber the body, so we
    // splice the description manually here.
    const allPatches = listPatchHeadingsInFile(outputPath, series);
    const merged = new Set<string>(allPatches);
    merged.add(`v${version}`);
    const sortedPatches = Array.from(merged).sort((a, b) => {
      const ap = parseInt(a.split(".")[2], 10);
      const bp = parseInt(b.split(".")[2], 10);
      return ap - bp;
    });
    const description = describeReleaseRange(sortedPatches, series);
    existing = rewriteFrontmatterDescription(existing, description);

    writeFileSync(outputPath, existing, "utf-8");
    console.log(`\nUpdated ${outputPath}`);
    console.log(`  Inserted ## v${version} section from ${entries.length} package(s)`);
    return;
  }

  // -------------------------------------------------------------------
  // Default path — full render of the series page for the X.Y.0 entry.
  // -------------------------------------------------------------------
  const overridesPath = resolve(
    websiteDir,
    "release-notes-overrides",
    `${version}.md`,
  );
  const overrides = parseOverrides(overridesPath);
  if (overrides.length > 0) {
    console.log(
      `  Loaded ${overrides.length} override section(s) from ${version}.md`,
    );
  }

  const pageTitle = isLatest
    ? `SDK Release Notes — ${series} (latest)`
    : `SDK Release Notes — ${series}`;
  const pageDescription = describeReleaseRange([`v${version}`], series);

  const rendered = nunjucks.render("release-notes-page.njk", {
    pageTitle,
    pageDescription,
    versions: [{ version, packages: entries }],
    overrides,
  });

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, rendered.trim() + "\n", "utf-8");

  console.log(`\nWrote ${outputPath}`);
  console.log(`  ## v${version} block from ${entries.length} package(s)`);
}

/**
 * Splice the frontmatter `description:` line of an MDX file in memory.
 * Used by the append-patch flow to bump the "Lists all releases ..."
 * range without touching the body.
 */
function rewriteFrontmatterDescription(
  content: string,
  newDescription: string,
): string {
  if (!content.startsWith("---\n")) return content;
  const closing = content.indexOf("\n---", 4);
  if (closing < 0) return content;
  const frontmatter = content.slice(0, closing + 4);
  const body = content.slice(closing + 4);
  const descRe = /^description:.*$/m;
  if (!descRe.test(frontmatter)) {
    // No description line — inject one immediately after `title:`.
    const titleRe = /^(title:.*)$/m;
    if (!titleRe.test(frontmatter)) return content;
    return (
      frontmatter.replace(titleRe, `$1\ndescription: ${newDescription}`) + body
    );
  }
  return frontmatter.replace(descRe, `description: ${newDescription}`) + body;
}

main();
