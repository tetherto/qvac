#!/usr/bin/env bun
/**
 * Generate a per-version release-notes MDX page for the SDK pod by reading
 * CHANGELOG.md from each pod package, normalizing section headings, merging
 * entries across packages, and rendering through `release-notes-page.njk`.
 *
 * Output target:
 *   - latest:  content/docs/sdk/release-notes/index.mdx
 *   - older:   content/docs/sdk/release-notes/v<X.Y.Z>.mdx
 *
 * Usage: bun run scripts/generate-release-notes.ts <version> [--latest]
 *                                                            [--aggregate-minor]
 *                                                            [--ai]
 *
 * Flags:
 *   --latest            Write to index.mdx instead of v<X.Y.Z>.mdx.
 *   --aggregate-minor   Roll up every patch within the version's minor
 *                       (e.g. v0.9.0 + v0.9.1) into a single page. Use
 *                       this with --latest so the "latest" notes capture
 *                       the cumulative minor release rather than just the
 *                       most recent patch.
 *   --ai                Use AI to generate a summary preamble when none
 *                       exists in the changelogs.
 *
 * Expects to run from docs/website/ inside the monorepo.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import nunjucks from "nunjucks";
import {
  extractVersionBlock,
  parseVersionBlock,
  mergeChangelogs,
  parseOverridesContent,
  escapeRegExp,
  type PackageChangelog,
  type OverrideSection,
} from "./lib/changelog-parser";

const SDK_POD_PACKAGES = ["sdk", "cli", "rag", "logging", "error"] as const;

function parseChangelog(
  filePath: string,
  pkg: string,
  version: string
): PackageChangelog | null {
  if (!existsSync(filePath)) return null;

  const content = readFileSync(filePath, "utf-8");
  const block = extractVersionBlock(content, version);
  if (!block) return null;

  const { preamble, sections } = parseVersionBlock(block);
  return { pkg, preamble, sections };
}

/**
 * List every patch of `version`'s minor that has an entry in `filePath`,
 * newest first (so v0.9.1 comes before v0.9.0 when both exist).
 *
 * `version` is user-supplied (CLI arg) so the major/minor segments are
 * regex-escaped before interpolation. The pre-flight semver check in
 * `main()` keeps this conservative — only digits and dots reach here —
 * but escaping is still the correct defensive posture.
 */
function listPatchesInMinor(filePath: string, version: string): string[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8");
  const [major, minor] = version.split(".");
  const re = new RegExp(
    `^## \\[(${escapeRegExp(major)}\\.${escapeRegExp(minor)}\\.\\d+)\\]`,
    "gm",
  );
  const versions = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) versions.add(m[1]);
  return Array.from(versions).sort((a, b) => {
    const ap = parseInt(a.split(".")[2], 10);
    const bp = parseInt(b.split(".")[2], 10);
    return bp - ap;
  });
}

function parseOverrides(filePath: string): OverrideSection[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8");
  return parseOverridesContent(content);
}

async function main() {
  const args = process.argv.slice(2);
  const version = args.find((arg) => !arg.startsWith("--"));
  const useAi = args.includes("--ai");
  const isLatest = args.includes("--latest");
  const aggregateMinor = args.includes("--aggregate-minor");

  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(
      "Usage: bun run scripts/generate-release-notes.ts <version> [--latest] [--aggregate-minor] [--ai]"
    );
    console.error("  version must be semver (e.g. 0.8.1)");
    process.exit(1);
  }

  const websiteDir = process.cwd();
  // `CHANGELOG_REPO_ROOT` lets the docs-release-pipeline point this script
  // at a checkout frozen at the release commit, so concurrent merges to
  // `main` during the workflow window can't smuggle stale or future
  // CHANGELOG entries into the rendered release notes. When unset (local
  // runs, post-merge sync) we fall back to the monorepo root above the
  // docs website directory — same as before.
  const repoRoot = process.env.CHANGELOG_REPO_ROOT
    ? resolve(process.env.CHANGELOG_REPO_ROOT)
    : resolve(websiteDir, "../..");

  console.log(
    `Generating release notes for v${version}` +
      (aggregateMinor ? ` (aggregating minor)` : "") +
      `...`,
  );
  if (process.env.CHANGELOG_REPO_ROOT) {
    console.log(`  Reading changelogs from: ${repoRoot}`);
  }
  console.log("");

  const changelogs: PackageChangelog[] = [];
  for (const pkg of SDK_POD_PACKAGES) {
    const changelogPath = resolve(
      repoRoot,
      "packages",
      pkg,
      "CHANGELOG.md"
    );
    if (!existsSync(changelogPath)) {
      console.log(`  Skipping @qvac/${pkg} (no CHANGELOG.md)`);
      continue;
    }

    // Versions to pull from this changelog. With --aggregate-minor we pull
    // every patch in the minor (newest first) so the rendered page covers
    // the cumulative release; otherwise just the named version.
    const versionsToParse = aggregateMinor
      ? listPatchesInMinor(changelogPath, version)
      : [version];

    if (versionsToParse.length === 0) {
      console.log(`  Skipping @qvac/${pkg} (v${version} not found)`);
      continue;
    }

    let pkgFound = false;
    for (const v of versionsToParse) {
      const parsed = parseChangelog(changelogPath, pkg, v);
      if (parsed) {
        // Tag aggregated entries with their patch version so the rendered
        // sub-headings can disambiguate "added in v0.9.1 vs v0.9.0".
        const taggedPkg = aggregateMinor && versionsToParse.length > 1
          ? `${pkg} (v${v})`
          : pkg;
        console.log(`  Found v${v} in @qvac/${pkg}`);
        changelogs.push({
          pkg: taggedPkg,
          preamble: parsed.preamble,
          sections: parsed.sections,
        });
        pkgFound = true;
      }
    }
    if (!pkgFound) {
      console.log(`  Skipping @qvac/${pkg} (v${version} not found)`);
    }
  }

  if (changelogs.length === 0) {
    console.error(
      `\nNo changelog entries found for v${version} in any SDK pod package.`
    );
    process.exit(1);
  }

  const categories = mergeChangelogs(changelogs);

  const preambles = changelogs
    .filter((c) => c.preamble.length > 0)
    .map((c) => ({ pkg: c.pkg, content: c.preamble }));

  if (useAi && preambles.length === 0 && categories.length > 0) {
    try {
      const { isAugmentConfigured, generateReleaseSummary } = await import(
        "./api-docs/ai-augment.js"
      );
      if (isAugmentConfigured()) {
        console.log("  🤖 No preamble found — generating AI summary...");
        const changeDescription = categories
          .map((c) =>
            c.packages.map((p) => `[${c.name}] @qvac/${p.pkg}: ${p.content}`).join("\n")
          )
          .join("\n");
        const affectedFunctions = categories
          .flatMap((c) => c.packages.map((p) => p.pkg))
          .join(", ");
        const summary = await generateReleaseSummary(
          categories[0].name,
          changeDescription.slice(0, 2000),
          affectedFunctions,
        );
        if (summary) {
          preambles.push({ pkg: "sdk", content: summary });
          console.log("  ✓ AI summary generated");
        }
      } else {
        console.log("  ⏭️  Skipping AI summary (env vars not configured)");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ⚠️  AI summary failed (non-fatal): ${msg}`);
    }
  }

  const overridesPath = resolve(
    websiteDir,
    "release-notes-overrides",
    `${version}.md`
  );
  const overrides = parseOverrides(overridesPath);
  if (overrides.length > 0) {
    console.log(
      `  Loaded ${overrides.length} override section(s) from ${version}.md`
    );
  }

  const templateDir = resolve(
    websiteDir,
    "scripts",
    "api-docs",
    "templates"
  );
  nunjucks.configure(templateDir, {
    autoescape: false,
    trimBlocks: true,
    lstripBlocks: true,
  });

  // Avoid emitting a duplicate `📦 NPM:` line: the SDK pod changelogs already
  // include the NPM link in their preamble (per the CHANGELOG_LLM convention),
  // so we only inject one when no preamble already carries it.
  // `version` is user-supplied — escape every regex meta character (not just
  // dots) before interpolating so an arbitrary CLI value can't smuggle a
  // pattern in. The semver guard at the top of `main()` already restricts
  // this to digits + dots in practice.
  const npmLinkRe = new RegExp(
    `npmjs\\.com/package/@qvac/sdk/v/${escapeRegExp(version)}`,
  );
  const hasPreambleNpmLink = preambles.some((p) => npmLinkRe.test(p.content));

  const rendered = nunjucks.render("release-notes-page.njk", {
    version,
    categories,
    preambles,
    overrides,
    generatedDate: new Date().toISOString().split("T")[0],
    hasPreambleNpmLink,
  });

  const outputPath = resolve(
    websiteDir,
    "content",
    "docs",
    "sdk",
    "release-notes",
    isLatest ? "index.mdx" : `v${version}.mdx`,
  );
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, rendered.trim() + "\n", "utf-8");

  console.log(`\nWrote ${outputPath}`);
  console.log(
    `  ${categories.length} category(s) from ${changelogs.length} package(s)`
  );
}

main();
