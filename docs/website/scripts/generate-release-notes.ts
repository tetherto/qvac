#!/usr/bin/env bun
/**
 * Generate a per-version release-notes MDX page for the SDK pod.
 *
 * Two source modes:
 *
 *   - **Per-version folder (Fonte B, default)** — reads
 *     `packages/<pkg>/changelog/<version>/CHANGELOG_LLM.md` (with fallback
 *     to raw `CHANGELOG.md`) for each SDK pod package. This is what the
 *     docs release workflows hit because the trigger is gated on changes
 *     to that folder, so by the time the workflow runs the content is
 *     guaranteed to exist and to be the polished version.
 *   - **Aggregated root (Fonte A, `--aggregate-minor`)** — reads the root
 *     `packages/<pkg>/CHANGELOG.md` and extracts every `## [X.Y.<patch>]`
 *     block in the same minor. Used for one-off manual regenerations
 *     when you need to recover the cumulative minor narrative.
 *
 * Output target:
 *   - latest:           content/docs/reference/release-notes/index.mdx
 *   - older:            content/docs/reference/release-notes/v<X.Y.Z>.mdx
 *   - --target=<file>:  content/docs/reference/release-notes/<file>
 *
 * Append-patch mode (`--append-patch`) renders ONLY the per-version
 * section (no frontmatter, no preamble NPM link) using the template
 * `release-notes-patch-section.njk` and appends it to the existing target.
 * Used by the patch flow so the cumulative minor narrative stays intact.
 *
 * Title-only mode (`--title-only`) skips changelog reads + rendering. It
 * opens the existing target MDX, rewrites only the frontmatter `title:`
 * line to the new version label (with or without the `(latest)` suffix,
 * driven by `--latest`), and keeps the body verbatim. Used by the minor
 * release orchestrator to relabel a freshly-frozen `vX.Y.Z.mdx` snapshot
 * (which inherits the outgoing `index.mdx` title verbatim) without
 * re-rendering changelog content.
 *
 * Usage: bun run scripts/generate-release-notes.ts <version> [flags]
 *
 * Flags:
 *   --latest            Write to index.mdx instead of v<X.Y.Z>.mdx.
 *   --target=<file>    Override output filename inside release-notes/
 *                      (mutually exclusive with --latest).
 *   --append-patch     Append a `## v<X.Y.Z>` section to the existing
 *                      target instead of regenerating from scratch.
 *   --aggregate-minor   Roll up every patch within the version's minor
 *                       (e.g. v0.9.0 + v0.9.1) into a single page from the
 *                       root CHANGELOG.md. Manual regen only; not used by
 *                       the release pipeline.
 *   --ai                Use AI to generate a summary preamble when none
 *                       exists in the changelogs.
 *   --title-only       Skip changelog parsing + render. Only rewrite the
 *                      frontmatter title of the existing target file. The
 *                      target must already exist (created by a prior
 *                      release pass).
 *
 * Expects to run from docs/website/ inside the monorepo.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import nunjucks from "nunjucks";
import {
  extractVersionBlock,
  parseVersionBlock,
  parseChangelogFolder,
  mergeChangelogs,
  parseOverridesContent,
  escapeRegExp,
  type PackageChangelog,
  type OverrideSection,
} from "./lib/changelog-parser";
import { rewriteFrontmatterTitleLine } from "./lib/release-shared.js";

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
  const appendPatch = args.includes("--append-patch");
  const titleOnly = args.includes("--title-only");
  const targetFlag = args.find((arg) => arg.startsWith("--target="));
  const target = targetFlag ? targetFlag.slice("--target=".length) : null;

  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(
      "Usage: bun run scripts/generate-release-notes.ts <version> [--latest] [--target=<file>] [--append-patch] [--aggregate-minor] [--ai] [--title-only]"
    );
    console.error("  version must be semver (e.g. 0.8.1)");
    process.exit(1);
  }

  if (isLatest && target) {
    console.error(
      "Error: --latest and --target=<file> are mutually exclusive."
    );
    process.exit(1);
  }

  if (titleOnly && (appendPatch || aggregateMinor || useAi)) {
    console.error(
      "Error: --title-only is incompatible with --append-patch / --aggregate-minor / --ai.",
    );
    process.exit(1);
  }

  const websiteDir = process.cwd();

  // Title-only path: rewrite only the frontmatter `title:` line of the
  // existing target MDX without touching changelogs, templates, or body.
  // Used by the minor release orchestrator after freezing the outgoing
  // `index.mdx` into `vX.Y.Z.mdx` — the snapshot inherits the outgoing
  // title verbatim (still advertises `(latest)` and possibly a different
  // version label), so we relabel it to the canonical archived form.
  if (titleOnly) {
    const titleOnlyOutput = resolve(
      websiteDir,
      "content",
      "docs",
      "reference",
      "release-notes",
      target ?? (isLatest ? "index.mdx" : `v${version}.mdx`),
    );
    const versionLabel = isLatest ? `v${version} (latest)` : `v${version}`;
    console.log(`📝 Title-only update for SDK Release Notes — ${versionLabel}...`);
    console.log(`   Target: ${titleOnlyOutput}`);
    await rewriteFrontmatterTitleLine(
      titleOnlyOutput,
      `SDK Release Notes — ${versionLabel}`,
    );
    console.log(`✅ Title-only update complete (${versionLabel})`);
    return;
  }

  // `CHANGELOG_REPO_ROOT` lets the docs release workflows point this script
  // at a checkout frozen at the release commit, so concurrent merges to
  // `main` during the workflow window can't smuggle stale or future
  // CHANGELOG entries into the rendered release notes. When unset (local
  // runs, post-merge sync) we fall back to the monorepo root above the
  // docs website directory — same as before.
  const repoRoot = process.env.CHANGELOG_REPO_ROOT
    ? resolve(process.env.CHANGELOG_REPO_ROOT)
    : resolve(websiteDir, "../..");

  // Source mode: aggregate-minor walks the root CHANGELOG.md per package;
  // otherwise we read the per-version folder (Fonte B). Fonte B is the
  // pipeline default — its trigger is gated on changes to the very
  // folder we read here, so the content is guaranteed to exist and to be
  // the polished `CHANGELOG_LLM.md` form (falling back to `CHANGELOG.md`
  // when the LLM-curated copy hasn't landed yet).
  const sourceMode = aggregateMinor ? "aggregate-minor" : "per-version-folder";
  console.log(
    `Generating release notes for v${version} (source: ${sourceMode})` +
      (appendPatch ? " [append-patch]" : "") +
      `...`,
  );
  if (process.env.CHANGELOG_REPO_ROOT) {
    console.log(`  Reading changelogs from: ${repoRoot}`);
  }
  console.log("");

  const changelogs: PackageChangelog[] = [];
  for (const pkg of SDK_POD_PACKAGES) {
    if (aggregateMinor) {
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

      // Every patch in the same minor, newest first, so the rendered
      // page captures the cumulative narrative.
      const versionsToParse = listPatchesInMinor(changelogPath, version);
      if (versionsToParse.length === 0) {
        console.log(`  Skipping @qvac/${pkg} (no v${version}-minor patches)`);
        continue;
      }

      let pkgFound = false;
      for (const v of versionsToParse) {
        const parsed = parseChangelog(changelogPath, pkg, v);
        if (parsed) {
          // Tag aggregated entries with their patch version so the rendered
          // sub-headings can disambiguate "added in v0.9.1 vs v0.9.0".
          const taggedPkg = versionsToParse.length > 1 ? `${pkg} (v${v})` : pkg;
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
    } else {
      // Fonte B: per-version folder under packages/<pkg>/changelog/<version>/
      const folderPath = resolve(
        repoRoot,
        "packages",
        pkg,
        "changelog",
        version,
      );
      const parsed = parseChangelogFolder(folderPath, pkg);
      if (!parsed) {
        console.log(
          `  Skipping @qvac/${pkg} (no changelog folder at ${folderPath})`,
        );
        continue;
      }
      console.log(`  Found v${version} folder for @qvac/${pkg}`);
      changelogs.push(parsed);
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

  const outputPath = resolve(
    websiteDir,
    "content",
    "docs",
    "reference",
    "release-notes",
    target ?? (isLatest ? "index.mdx" : `v${version}.mdx`),
  );

  if (appendPatch) {
    // Append-patch path: render the per-version section only and append
    // it to the existing target. We require the target to exist already
    // (created by the original minor release) so the cumulative minor
    // narrative is preserved verbatim.
    if (!existsSync(outputPath)) {
      console.error(
        `❌ --append-patch requires existing target: ${outputPath}\n` +
          `   Run the minor release first, or pick the archived sibling.`,
      );
      process.exit(1);
    }
    const section = nunjucks.render("release-notes-patch-section.njk", {
      version,
      categories,
      preambles,
      overrides,
      hasPreambleNpmLink,
    });
    const existing = readFileSync(outputPath, "utf-8").replace(/\s+$/, "");
    const appended = `${existing}\n\n${section.trim()}\n`;
    writeFileSync(outputPath, appended, "utf-8");
    console.log(`\nAppended v${version} section to ${outputPath}`);
    console.log(
      `  ${categories.length} category(s) from ${changelogs.length} package(s)`,
    );
    return;
  }

  // Precompute the full version label (with optional `(latest)` suffix)
  // so the template can drop it into the frontmatter title via a single
  // `{{ versionLabel }}` expression. Using an expression tag (vs. a
  // `{% if %}` block tag) avoids `trimBlocks: true` swallowing the
  // newline between the title and `description:` lines.
  const versionLabel = isLatest ? `v${version} (latest)` : `v${version}`;
  const rendered = nunjucks.render("release-notes-page.njk", {
    version,
    versionLabel,
    categories,
    preambles,
    overrides,
    generatedDate: new Date().toISOString().split("T")[0],
    hasPreambleNpmLink,
  });

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, rendered.trim() + "\n", "utf-8");

  console.log(`\nWrote ${outputPath}`);
  console.log(
    `  ${categories.length} category(s) from ${changelogs.length} package(s)`
  );
}

main();
