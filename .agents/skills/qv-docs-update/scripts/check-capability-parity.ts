#!/usr/bin/env bun
/**
 * Validation gate 4 of qv-docs-update — capability registration parity.
 *
 * An AI capability page is registered in four places, and only one of them
 * fails loudly:
 *
 *   1. content/docs/sdk/<line>/ai-capabilities/<slug>.mdx   the page
 *   2. content/docs/ecosystem/index.mdx                     a <Card> in the grid, plus the icon import
 *   3. content/docs/sdk/<line>/index.mdx                    a bullet under "### AI tasks"
 *   4. content/docs/sdk/<line>/ai-capabilities/meta.json    the sidebar entry
 *
 * Forget the icon import in (2) and the build breaks. Forget the card, the
 * bullet, or the meta.json entry and everything passes: the page renders at a
 * valid URL, the link checker is happy, the tests are green — and the
 * capability is invisible everywhere a user would look for it. That is the
 * silent failure mode this script exists to catch, and no other command in the
 * repo covers it.
 *
 * `<line>` is the collection's current documentation line, the folder written
 * in parentheses. It is resolved at runtime: the folder changes at every
 * release, and a stale constant would check a shipped version instead.
 *
 * The sidebar moved out of `src/lib/custom-tree.ts` when the SDK became a
 * versioned collection. A line now declares its own navigation in `meta.json`,
 * and a page's icon in its own frontmatter, so the two registers this script
 * reads for (4) are the page list and the page itself.
 *
 * Usage:
 *   bun run check-capability-parity.ts [--repo <path>] [--json]
 *
 * Exit codes:
 *   0  parity holds (accepted exceptions do not fail)
 *   1  a divergence was found
 *   2  a required file is missing
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Accepted exceptions
//
// batch-processing has a page, a bullet and a sidebar entry, but deliberately
// no card on the Ecosystem overview: it is arguably a modality of text
// generation rather than a standalone capability, and the grid is kept lean.
// Recorded here so the gate reports a real regression instead of this known
// state. Remove the entry if a card is ever added.
// ---------------------------------------------------------------------------

const ACCEPTED_MISSING_CARD = new Set(["batch-processing"]);

// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let repoRoot: string | null = null;
let asJson = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--repo") repoRoot = args[++i] ?? null;
  else if (a === "--json") asJson = true;
  else if (a === "-h" || a === "--help") {
    console.log("usage: check-capability-parity.ts [--repo <path>] [--json]");
    process.exit(0);
  } else {
    console.error(`check-capability-parity: unknown argument: ${a}`);
    process.exit(2);
  }
}

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const REPO = repoRoot ?? path.resolve(SCRIPT_DIR, "..", "..", "..", "..");
const WEBSITE = path.join(REPO, "docs", "website");
const DOCS_CONTENT = path.join(WEBSITE, "content", "docs");

/** The parenthesized folder: the line answering the version-less addresses. */
function currentLineOf(collection: string): string {
  const dir = path.join(DOCS_CONTENT, collection);
  if (!fs.existsSync(dir)) {
    console.error(`check-capability-parity: no collection at ${dir}`);
    process.exit(2);
  }
  const groups = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\(v\d+\.\d+\)$/.test(e.name))
    .map((e) => e.name);

  if (groups.length !== 1) {
    console.error(
      `check-capability-parity: ${collection} has ${groups.length} current lines (${groups.join(", ") || "none"}); exactly one folder must be parenthesized`,
    );
    process.exit(2);
  }
  return groups[0]!;
}

const SDK_LINE = currentLineOf("sdk");
const SDK_DIR = path.join(DOCS_CONTENT, "sdk", SDK_LINE);

const CAPABILITIES_DIR = path.join(SDK_DIR, "ai-capabilities");
const CAPABILITIES_META = path.join(CAPABILITIES_DIR, "meta.json");
const ECOSYSTEM_MDX = path.join(DOCS_CONTENT, "ecosystem", "index.mdx");
const SDK_INDEX_MDX = path.join(SDK_DIR, "index.mdx");

/** Where the grid and the bullets point: the version-less capability URL. */
const CAPABILITY_URL_PREFIX = "/sdk/ai-capabilities/";

function readOrDie(file: string): string {
  if (!fs.existsSync(file)) {
    console.error(`check-capability-parity: missing required file: ${file}`);
    process.exit(2);
  }
  return fs.readFileSync(file, "utf-8");
}

/** The `icon:` a page declares in its frontmatter, or null when it declares none. */
function frontmatterIcon(file: string): string | null {
  const text = fs.readFileSync(file, "utf-8");
  const block = text.match(/^---\n([\s\S]*?)\n---/);
  if (!block) return null;
  const icon = block[1]!.match(/^icon:\s*(\S+)\s*$/m);
  return icon ? icon[1]! : null;
}

// ---------------------------------------------------------------------------
// The four registers
// ---------------------------------------------------------------------------

interface Registers {
  pages: string[];
  cards: Map<string, string>; // slug -> icon identifier used in the card
  ecosystemImports: Set<string>; // identifiers imported from lucide-react
  /**
   * Local identifier -> the Lucide export it aliases. `Image as ImageIcon`
   * yields ImageIcon -> Image. A page's frontmatter names the Lucide export
   * directly (`icon: Image`), so comparing the card's local identifier against
   * it without resolving the alias reports a mismatch that is not one.
   */
  importAliases: Map<string, string>;
  bullets: Set<string>;
  nav: string[]; // slugs listed in ai-capabilities/meta.json, in sidebar order
  icons: Map<string, string | null>; // slug -> frontmatter icon
}

function collect(): Registers {
  const pages = fs
    .readdirSync(CAPABILITIES_DIR)
    .filter((f) => f.endsWith(".mdx") && f !== "index.mdx")
    .map((f) => path.basename(f, ".mdx"))
    .sort();

  const ecosystem = readOrDie(ECOSYSTEM_MDX);
  const sdkIndex = readOrDie(SDK_INDEX_MDX);
  const meta = readOrDie(CAPABILITIES_META);

  // 2a. Cards, with the icon each one renders.
  const cards = new Map<string, string>();
  for (const m of ecosystem.matchAll(
    new RegExp(
      `<Card\\s+href="${CAPABILITY_URL_PREFIX}([^"]+)"[\\s\\S]*?<(\\w+)\\s+className="size-4`,
      "g",
    ),
  )) {
    cards.set(m[1]!, m[2]!);
  }

  // 2b. Identifiers imported from lucide-react. `Image as ImageIcon` is
  // aliased because a bare `Image` collides with the global in MDX scope; the
  // alias is the identifier the card must use.
  const ecosystemImports = new Set<string>();
  const importAliases = new Map<string, string>();
  for (const m of ecosystem.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"]/g,
  )) {
    for (const raw of m[1]!.split(",")) {
      const part = raw.trim();
      if (!part) continue;
      const alias = part.match(/^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/);
      if (alias) {
        ecosystemImports.add(alias[2]!);
        importAliases.set(alias[2]!, alias[1]!);
      } else {
        ecosystemImports.add(part);
        importAliases.set(part, part);
      }
    }
  }

  // 3. Bullets under "### AI tasks" on the SDK collection overview.
  const bullets = new Set<string>();
  for (const m of sdkIndex.matchAll(
    new RegExp(`\\]\\(${CAPABILITY_URL_PREFIX}([^)#]+)\\)`, "g"),
  )) {
    bullets.add(m[1]!);
  }

  // 4a. The line's own navigation. `pages` is an explicit, ordered list with no
  // catch-all, so a slug missing from it is a page missing from the sidebar.
  let nav: string[] = [];
  try {
    const parsed = JSON.parse(meta) as { pages?: unknown };
    nav = Array.isArray(parsed.pages)
      ? parsed.pages.filter((p): p is string => typeof p === "string")
      : [];
  } catch (error) {
    console.error(
      `check-capability-parity: ${CAPABILITIES_META} is not valid JSON: ${error instanceof Error ? error.message : error}`,
    );
    process.exit(2);
  }

  // 4b. The icon each page declares for itself. In a versioned collection the
  // navigation is composed from the content, so the page carries its own icon
  // rather than a hand-written tree carrying it.
  const icons = new Map<string, string | null>();
  for (const slug of pages) {
    icons.set(slug, frontmatterIcon(path.join(CAPABILITIES_DIR, `${slug}.mdx`)));
  }

  return { pages, cards, ecosystemImports, importAliases, bullets, nav, icons };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

interface Finding {
  slug: string;
  detail: string;
  accepted: boolean;
}

function check(r: Registers): Finding[] {
  const findings: Finding[] = [];
  const pageSet = new Set(r.pages);
  const navSet = new Set(r.nav);

  for (const slug of r.pages) {
    if (!r.cards.has(slug)) {
      findings.push({
        slug,
        detail: `no <Card href="${CAPABILITY_URL_PREFIX}${slug}"> in content/docs/ecosystem/index.mdx (the home grid)`,
        accepted: ACCEPTED_MISSING_CARD.has(slug),
      });
    }
    if (!r.bullets.has(slug)) {
      findings.push({
        slug,
        detail: `no bullet linking ${CAPABILITY_URL_PREFIX}${slug} under "### AI tasks" in sdk/${SDK_LINE}/index.mdx`,
        accepted: false,
      });
    }
    if (!navSet.has(slug)) {
      findings.push({
        slug,
        detail: `not listed in sdk/${SDK_LINE}/ai-capabilities/meta.json — the page would be reachable by URL and invisible in navigation`,
        accepted: false,
      });
    }
    if (!r.icons.get(slug)) {
      findings.push({
        slug,
        detail: `no \`icon:\` in the page's frontmatter — the sidebar entry would render without one, unlike every neighbour`,
        accepted: false,
      });
    }
  }

  // Registrations pointing at a page that does not exist: a dead link, and the
  // reverse of the failure above.
  for (const [slug] of r.cards) {
    if (!pageSet.has(slug)) {
      findings.push({
        slug,
        detail: "card in ecosystem/index.mdx points at a non-existent page",
        accepted: false,
      });
    }
  }
  for (const slug of r.bullets) {
    if (!pageSet.has(slug)) {
      findings.push({
        slug,
        detail: `bullet in sdk/${SDK_LINE}/index.mdx points at a non-existent page`,
        accepted: false,
      });
    }
  }
  for (const slug of r.nav) {
    if (!pageSet.has(slug)) {
      findings.push({
        slug,
        detail: `ai-capabilities/meta.json lists a page that does not exist in this line`,
        accepted: false,
      });
    }
  }

  // Icon consistency: the card icon must be imported (this one breaks the
  // build), and the card and the page must declare the same icon (this one
  // does not break anything, and is exactly why it needs checking).
  for (const [slug, icon] of r.cards) {
    if (!r.ecosystemImports.has(icon)) {
      findings.push({
        slug,
        detail: `card renders <${icon}> but ${icon} is not imported from lucide-react in ecosystem/index.mdx — this breaks the build`,
        accepted: false,
      });
    }

    const pageIcon = r.icons.get(slug);
    const cardIcon = r.importAliases.get(icon) ?? icon;
    if (pageIcon && pageIcon !== cardIcon) {
      const shown = cardIcon === icon ? icon : `${icon} (alias of ${cardIcon})`;
      findings.push({
        slug,
        detail: `icon mismatch: card uses ${shown}, the page's frontmatter declares ${pageIcon}`,
        accepted: false,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const registers = collect();
const findings = check(registers);
const real = findings.filter((f) => !f.accepted);
const accepted = findings.filter((f) => f.accepted);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        passed: real.length === 0,
        line: SDK_LINE,
        counts: {
          pages: registers.pages.length,
          cards: registers.cards.size,
          bullets: registers.bullets.size,
          nav: registers.nav.length,
        },
        findings: real,
        accepted,
      },
      null,
      2,
    ),
  );
  process.exit(real.length === 0 ? 0 : 1);
}

console.log(`=== AI capability registration parity — SDK ${SDK_LINE} ===\n`);
console.log(`  pages    ${registers.pages.length}`);
console.log(`  cards    ${registers.cards.size}   (ecosystem/index.mdx)`);
console.log(`  bullets  ${registers.bullets.size}   (sdk/${SDK_LINE}/index.mdx)`);
console.log(`  nav      ${registers.nav.length}   (ai-capabilities/meta.json)\n`);

for (const f of accepted) {
  console.log(`  ACCEPTED  ${f.slug}: ${f.detail}`);
}
if (accepted.length > 0) console.log();

if (real.length === 0) {
  console.log("  PASS  all four registers agree\n");
  process.exit(0);
}

console.log(`  FAIL  ${real.length} divergence(s)`);
for (const f of real) {
  console.log(`    - ${f.slug}: ${f.detail}`);
}
console.log();
process.exit(1);
