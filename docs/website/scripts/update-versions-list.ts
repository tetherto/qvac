#!/usr/bin/env bun
/**
 * Refresh `src/lib/versions.ts` from the contents of `content/docs/reference/api/`
 * and `content/docs/reference/release-notes/`.
 *
 * The site has two versioned sections (API summary, release notes), each
 * served as a single MDX file **per minor series**:
 *   - `<basePath>/index.mdx`        — current latest minor series
 *   - `<basePath>/vX.Y.x.mdx`       — archived minor series (literal `x`,
 *                                     accumulates patches as `## vX.Y.Z`
 *                                     sections inside the file)
 *
 * This script discovers all `vX.Y.x.mdx` siblings, sorts them descending
 * by major/minor, and rewrites `versions.ts` so the version selector
 * dropdowns always reflect what's on disk.
 *
 * Two fields encode the "latest" pointer:
 *   - `latest`        — precise current patch (e.g. `v0.11.3`). Used for
 *                       page titles ("v0.11.x (latest)") and description
 *                       ranges ("Lists all releases from v0.11.0 to v0.11.3").
 *   - `latestSeries`  — series form (e.g. `v0.11.x`). URL slug + selector
 *                       value for the current-latest entry; `index.mdx`
 *                       is served at `latestSeries`.
 *
 * Usage:
 *   bun run scripts/update-versions-list.ts [--latest=X.Y.Z]
 *
 * `--latest=X.Y.Z` (full semver) overrides which patch is marked latest
 * in the manifest. When omitted the script reads the SDK's `package.json`
 * version, which is the source of truth in normal release flows.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCS_WEBSITE_DIR = path.resolve(SCRIPT_DIR, "..");
const SDK_PKG_JSON = path.resolve(
  SCRIPT_DIR,
  "..",
  "..",
  "..",
  "packages",
  "sdk",
  "package.json",
);

/** Match `v<major>.<minor>.x` (series form). */
const SERIES_VALUE_RE = /^v(\d+)\.(\d+)\.x$/;

/** Match `v<major>.<minor>.x.mdx` (on-disk series snapshot). */
const SERIES_FILENAME_RE = /^v(\d+)\.(\d+)\.x\.mdx$/;

function compareSeriesDesc(a: string, b: string): number {
  const aMatch = SERIES_VALUE_RE.exec(a);
  const bMatch = SERIES_VALUE_RE.exec(b);
  if (!aMatch || !bMatch) return 0;
  const aMajor = Number(aMatch[1]);
  const bMajor = Number(bMatch[1]);
  if (aMajor !== bMajor) return bMajor - aMajor;
  const aMinor = Number(aMatch[2]);
  const bMinor = Number(bMatch[2]);
  return bMinor - aMinor;
}

async function discoverSectionSeries(sectionDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(sectionDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name !== "index.mdx")
    .map((e) => SERIES_FILENAME_RE.exec(e.name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => `v${m[1]}.${m[2]}.x`)
    .sort(compareSeriesDesc);
}

async function readSdkVersion(): Promise<string> {
  const raw = await fs.readFile(SDK_PKG_JSON, "utf-8");
  const pkg = JSON.parse(raw) as { version?: string };
  if (!pkg.version) {
    throw new Error(`Could not read version from ${SDK_PKG_JSON}`);
  }
  return `v${pkg.version}`;
}

/** Parse `v<major>.<minor>.<patch>` and return the series form. */
function seriesOf(fullSemver: string): string {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(fullSemver);
  if (!match) {
    throw new Error(
      `Latest version must be full semver (vX.Y.Z), got: ${fullSemver}`,
    );
  }
  return `v${match[1]}.${match[2]}.x`;
}

function buildSectionLiteral(
  basePath: string,
  latest: string,
  latestSeries: string,
  olderSeries: string[],
): string {
  // Strip latestSeries from the olderSeries set so we don't double-list
  // the current latest minor as both the (latest) entry and an archived
  // sibling — useful when the index.mdx has already been frozen as
  // v<latestSeries>.mdx during a release flow.
  const filteredOlder = olderSeries.filter((s) => s !== latestSeries);

  const lines: string[] = [];
  lines.push(`{`);
  lines.push(`  basePath: '${basePath}',`);
  lines.push(`  latest: '${latest}',`);
  lines.push(`  latestSeries: '${latestSeries}',`);
  lines.push(`  versions: [`);
  lines.push(
    `    { label: '${latestSeries} (latest)', value: '${latestSeries}', isLatest: true },`,
  );
  for (const v of filteredOlder) {
    lines.push(`    { label: '${v}', value: '${v}' },`);
  }
  lines.push(`  ],`);
  lines.push(`}`);
  return lines.join("\n");
}

async function updateVersionsList(latestOverride?: string) {
  console.log(`📋 Updating versions list...`);

  const apiDir = path.join(
    DOCS_WEBSITE_DIR,
    "content",
    "docs",
    "reference",
    "api",
  );
  const releaseNotesDir = path.join(
    DOCS_WEBSITE_DIR,
    "content",
    "docs",
    "reference",
    "release-notes",
  );

  const latest = latestOverride
    ? latestOverride.startsWith("v")
      ? latestOverride
      : `v${latestOverride}`
    : await readSdkVersion();
  const latestSeries = seriesOf(latest);
  console.log(`   Latest: ${latest}`);
  console.log(`   Latest series: ${latestSeries}`);

  const apiOlder = await discoverSectionSeries(apiDir);
  const releaseNotesOlder = await discoverSectionSeries(releaseNotesDir);
  console.log(
    `   API series on disk: ${apiOlder.join(", ") || "(none)"}`,
  );
  console.log(
    `   Release notes series on disk: ${releaseNotesOlder.join(", ") || "(none)"}`,
  );

  const apiSection = buildSectionLiteral(
    "/reference/api",
    latest,
    latestSeries,
    apiOlder,
  );
  const releaseNotesSection = buildSectionLiteral(
    "/reference/release-notes",
    latest,
    latestSeries,
    releaseNotesOlder,
  );

  const content = `/**
 * Section-scoped version manifest. Only the API summary and the release
 * notes are versioned in the docs site — everything else (about-qvac,
 * getting-started, examples, tutorials, addons, cli, http-server) lives at
 * a single bare path that always reflects the current SDK.
 *
 * Each section is a single content folder under \`content/docs/<basePath>/\`:
 *   - The latest minor series is served from \`index.mdx\` at the bare
 *     basePath.
 *   - Older minor series are served from \`<basePath>/v<X.Y>.x\` via a
 *     sibling MDX file (\`v<X.Y>.x.mdx\`, literal "x"). The sibling
 *     accumulates patch sections (\`## vX.Y.Z\`) for that minor line.
 *
 * Auto-generated by \`scripts/update-versions-list.ts\` — do not edit by
 * hand for routine releases.
 */

export interface VersionEntry {
  label: string;
  value: string;
  isLatest?: boolean;
}

export interface VersionedSection {
  basePath: string;
  /**
   * Precise current patch (e.g. \`v0.11.3\`). Used by page renderers to
   * advertise the latest-patch number in titles / description ranges.
   * Not used for URL routing — that goes through \`latestSeries\`.
   */
  latest: string;
  /**
   * Series form of the current latest minor (e.g. \`v0.11.x\`). This is
   * the URL slug + version-selector value of the (latest) entry, and
   * the path \`index.mdx\` is served from at the bare \`basePath\`.
   */
  latestSeries: string;
  versions: VersionEntry[];
}

export const API_SECTION: VersionedSection = ${apiSection};

export const RELEASE_NOTES_SECTION: VersionedSection = ${releaseNotesSection};

const VERSIONED_SECTIONS: VersionedSection[] = [
  API_SECTION,
  RELEASE_NOTES_SECTION,
];

/**
 * Re-exported for backward compatibility with consumers that advertise the
 * latest SDK version in plain text (e.g. the \`llms.txt\` route). Carries
 * the precise patch number, not the series.
 */
export const LATEST_VERSION = API_SECTION.latest;

/**
 * Return the versioned section the given pathname falls under, or \`null\`
 * when the pathname is not within any versioned section.
 */
export function getVersionedSection(
  pathname: string,
): VersionedSection | null {
  const normalized = pathname.replace(/\\/+$/, '') || '/';
  return (
    VERSIONED_SECTIONS.find(
      (section) =>
        normalized === section.basePath ||
        normalized.startsWith(section.basePath + '/'),
    ) ?? null
  );
}

/**
 * Extract the current series slug from a versioned-section pathname.
 * Returns \`section.latestSeries\` when on the bare \`basePath\`
 * (\`index.mdx\` — the current latest minor series).
 */
export function getCurrentVersion(
  pathname: string,
  section: VersionedSection,
): string {
  const tail = pathname
    .slice(section.basePath.length)
    .replace(/^\\/+|\\/+$/g, '');
  if (!tail) return section.latestSeries;
  return tail.split('/')[0];
}

/**
 * Build the URL to navigate to when the user picks a target series inside
 * a section. The current latest series maps to \`basePath/\`; any other
 * series maps to \`basePath/<value>/\`.
 *
 * Trailing slash is mandatory: these URLs are consumed by the browser-side
 * version selector, and archived series slugs contain dots (\`v0.8.x\`).
 * Sevalla's Pretty URLs treats a bare dotted final segment as a file
 * request and 404s it before \`_redirects\` runs, so the bare→with-slash
 * normalization never fires for them. Emitting the trailing-slash form
 * directly lands on the \`200\` rewrite (see \`public/_redirects\`).
 */
export function computeSectionVersionUrl(
  section: VersionedSection,
  targetVersion: string,
): string {
  if (targetVersion === section.latestSeries) return \`\${section.basePath}/\`;
  return \`\${section.basePath}/\${targetVersion}/\`;
}

/**
 * Props consumed by the client-side \`<VersionSelector>\` popover. All values
 * are precomputed at build time from the page slug so the client component
 * can stay a pure presentation layer (no \`usePathname()\`, no version-list
 * lookups in the browser).
 */
export interface VersionSelectorProps {
  versions: VersionEntry[];
  currentVersion: string;
  currentLabel: string;
  /**
   * Map of version \`value\` → absolute URL the user should land on when
   * picking that version. Keyed by \`version.value\` to avoid recomputing
   * \`computeSectionVersionUrl\` in the browser.
   */
  versionUrls: Record<string, string>;
}

/**
 * Compute the props for \`<VersionSelector>\` from a static page slug. Returns
 * \`null\` when the slug is not inside a versioned section so the page can
 * skip rendering (and importing) the component entirely.
 */
export function getVersionSelectorProps(
  slug: readonly string[],
): VersionSelectorProps | null {
  const pathname = \`/\${slug.join('/')}\`;
  const section = getVersionedSection(pathname);
  if (!section) return null;

  const currentVersion = getCurrentVersion(pathname, section);
  const currentLabel =
    section.versions.find((v) => v.value === currentVersion)?.label ??
    currentVersion;

  const versionUrls: Record<string, string> = {};
  for (const version of section.versions) {
    versionUrls[version.value] = computeSectionVersionUrl(section, version.value);
  }

  return {
    versions: section.versions,
    currentVersion,
    currentLabel,
    versionUrls,
  };
}
`;

  const versionsFile = path.join(DOCS_WEBSITE_DIR, "src", "lib", "versions.ts");
  await fs.writeFile(versionsFile, content, "utf-8");
  console.log(`✅ Updated ${versionsFile}`);
}

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: bun run scripts/update-versions-list.ts [--latest=X.Y.Z]");
  console.log("");
  console.log(
    "  --latest=X.Y.Z  Override which patch is marked latest. Defaults",
  );
  console.log(
    "                  to the SDK package.json version.",
  );
  process.exit(0);
}

const latestFlag = args.find((a) => a.startsWith("--latest="));
const latestOverride = latestFlag?.split("=")[1];

updateVersionsList(latestOverride).catch((error) => {
  console.error("❌ Error updating versions list:", error.message);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
