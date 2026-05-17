/**
 * Shared helpers for the docs release orchestrators (`release-version-minor.ts`
 * and `release-version-patch.ts`). Centralising these avoids duplicating
 * filesystem walks, version parsing, and `versions.ts` lookups across the
 * two scripts — keeping minor / patch parity easy to verify.
 *
 * Every export here is **pure-ish** (no global state): callers supply paths
 * so unit tests can point them at fixtures without monkey-patching `cwd`.
 */

import { readFileSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the docs/website/ folder (sibling of `scripts/`). */
export const DOCS_WEBSITE_DIR = path.resolve(SCRIPT_DIR, "..", "..");

/**
 * Absolute path to the versioned-content root. Both `api/` and
 * `release-notes/` live directly under here.
 */
export const CONTENT_REFERENCE = path.join(
  DOCS_WEBSITE_DIR,
  "content",
  "docs",
  "reference",
);

/** Absolute path to the API summary section directory. */
export const API_DIR = path.join(CONTENT_REFERENCE, "api");

/** Absolute path to the release notes section directory. */
export const RELEASE_NOTES_DIR = path.join(CONTENT_REFERENCE, "release-notes");

/** Absolute path to the version manifest the SPA reads at runtime. */
export const VERSIONS_TS = path.join(
  DOCS_WEBSITE_DIR,
  "src",
  "lib",
  "versions.ts",
);

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Strict semver parser. Accepts `X.Y.Z` or `vX.Y.Z`. Throws on anything
 * else — the docs pipeline never legitimately sees pre-release / build
 * metadata strings, so silent fallback would hide real bugs.
 */
export function parseVersion(v: string): SemVer {
  const trimmed = v.replace(/^v/, "");
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `Invalid version: "${v}". Expected semver X.Y.Z (with optional leading v).`,
    );
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** Returns `true` when both versions share the same `X.Y` prefix. */
export function sameMinor(a: SemVer, b: SemVer): boolean {
  return a.major === b.major && a.minor === b.minor;
}

/**
 * Reads the `latest` field out of `src/lib/versions.ts` without importing
 * the module (which would require resolving the React/Next deps tree).
 * Returns the `vX.Y.Z` string verbatim, or `null` when the file is missing
 * / unparseable — callers decide whether that's fatal.
 */
export function readLatestFromVersionsTs(
  versionsPath: string = VERSIONS_TS,
): string | null {
  try {
    const content = readFileSync(versionsPath, "utf-8");
    // Both API_SECTION and RELEASE_NOTES_SECTION are kept in lockstep by
    // `update-versions-list.ts`, so reading the first `latest:` entry is
    // sufficient.
    const match = content.match(/latest:\s*'(v\d+\.\d+\.\d+)'/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** Async wrapper around `fs.stat` returning a boolean. */
export async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Logs a section header + the command and runs it synchronously through
 * `bash`. Output streams directly to the caller's stdout so CI logs render
 * exactly as the developer sees them locally.
 *
 * `cwd` defaults to `DOCS_WEBSITE_DIR` because every orchestrator step
 * runs from there.
 */
export function runStep(
  label: string,
  cmd: string,
  cwd: string = DOCS_WEBSITE_DIR,
): void {
  console.log(`\n${label}`);
  console.log(`   $ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd });
}

/**
 * Scan `sectionDir` for an archived `vX.Y.<any>.mdx` sibling that matches
 * the given (major, minor) tuple. Returns the basename (e.g. `v0.8.1.mdx`)
 * of the highest patch number found, or `null` when nothing matches.
 *
 * Used by the patch orchestrator's `patch-archived` branch to find the
 * file we need to rename. We pick the **highest** patch (rather than
 * erroring on multiple matches) so a re-run of the same workflow stays
 * idempotent — first run produces `v0.8.1.mdx`, second `v0.8.2.mdx`,
 * etc.
 */
export async function resolveArchivedSibling(
  sectionDir: string,
  major: number,
  minor: number,
): Promise<string | null> {
  let entries;
  try {
    entries = await fs.readdir(sectionDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const re = new RegExp(`^v${major}\\.${minor}\\.(\\d+)\\.mdx$`);
  let best: { name: string; patch: number } | null = null;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = re.exec(entry.name);
    if (!match) continue;
    const patch = Number(match[1]);
    if (best === null || patch > best.patch) {
      best = { name: entry.name, patch };
    }
  }
  return best?.name ?? null;
}

/**
 * Run `git mv <from> <to>` from `cwd`. Falls back to `fs.rename` when not
 * inside a git work tree — useful when scripts are exercised by Vitest
 * fixtures that don't bother with a `.git` directory.
 */
export async function gitMove(
  from: string,
  to: string,
  cwd: string = DOCS_WEBSITE_DIR,
): Promise<void> {
  try {
    execSync(`git mv ${shellQuote(from)} ${shellQuote(to)}`, {
      stdio: "inherit",
      cwd,
    });
  } catch {
    await fs.rename(from, to);
    console.log(`   (git mv failed — fell back to fs.rename)`);
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Rewrite the single `title:` line inside the frontmatter block of an
 * existing MDX file, preserving the body byte-for-byte. The caller passes
 * the **full title value** (everything after `title: `), not just the
 * version label — keeping the prefix decision (`"API Summary — ..."` vs
 * `"SDK Release Notes — ..."`) at the call site.
 *
 * Used by:
 *   - the patch flow, to bump a patch version in-place without re-running
 *     TypeDoc / re-rendering release notes (must not introduce new public
 *     API surface by definition);
 *   - the minor flow, to relabel a freshly-frozen `vX.Y.Z.mdx` snapshot
 *     so the herdaded `title:` from the outgoing `index.mdx` (which still
 *     advertised `(latest)` and possibly a different version number) is
 *     replaced with the canonical archived label.
 *
 * Failure modes are surfaced as exceptions so the orchestrator fails fast
 * instead of silently producing a stale title:
 *   - file must exist and begin with `---\n`;
 *   - frontmatter terminator (`\n---`) must be present;
 *   - frontmatter must contain a `title:` line.
 *
 * Exported so unit tests can validate the body-preserving behaviour
 * without spinning up the full TypeDoc pipeline.
 */
export async function rewriteFrontmatterTitleLine(
  filePath: string,
  fullTitle: string,
): Promise<void> {
  const existing = await fs.readFile(filePath, "utf-8");
  if (!existing.startsWith("---\n")) {
    throw new Error(
      `Title rewrite requires an existing MDX with frontmatter: ${filePath}`,
    );
  }
  const closing = existing.indexOf("\n---", 4);
  if (closing < 0) {
    throw new Error(
      `Title rewrite: could not find frontmatter terminator in ${filePath}`,
    );
  }
  // Frontmatter spans [0 .. closing+4) (the second `---` line included).
  const frontmatter = existing.slice(0, closing + 4);
  const body = existing.slice(closing + 4);

  // Match a `title:` line (with or without quoting) inside the frontmatter
  // only. We keep this conservative — don't touch a `title:` that might
  // appear in code-fenced examples in the body.
  const titleRe = /^title:.*$/m;
  if (!titleRe.test(frontmatter)) {
    throw new Error(
      `Title rewrite: no \`title:\` line found in frontmatter of ${filePath}`,
    );
  }
  const newFrontmatter = frontmatter.replace(titleRe, `title: ${fullTitle}`);
  await fs.writeFile(filePath, newFrontmatter + body, "utf-8");
}
