#!/usr/bin/env bun
/**
 * Validation gate 4 of qv-docs-update — capability registration parity.
 *
 * An AI capability page is registered in four places, and only one of them
 * fails loudly:
 *
 *   1. content/docs/ai-capabilities/<slug>.mdx   the page
 *   2. content/docs/index.mdx                    a <Card> in the grid, plus the icon import
 *   3. content/docs/introduction.mdx             a bullet under "### AI tasks"
 *   4. src/lib/custom-tree.ts                    a sidebar entry
 *
 * Forget the icon import in (2) and the build breaks. Forget the card, the
 * bullet, or the sidebar entry and everything passes: the page renders at a
 * valid URL, the link checker is happy, the tests are green — and the
 * capability is invisible everywhere a user would look for it. That is the
 * silent failure mode this script exists to catch, and no other command in the
 * repo covers it.
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
// no card on the home page: it is arguably a modality of text generation
// rather than a standalone capability, and the grid is kept lean. Recorded
// here so the gate reports a real regression instead of this known state.
// Remove the entry if a card is ever added.
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

const CAPABILITIES_DIR = path.join(WEBSITE, "content", "docs", "ai-capabilities");
const HOME_MDX = path.join(WEBSITE, "content", "docs", "index.mdx");
const INTRO_MDX = path.join(WEBSITE, "content", "docs", "introduction.mdx");
const CUSTOM_TREE = path.join(WEBSITE, "src", "lib", "custom-tree.ts");

function readOrDie(file: string): string {
  if (!fs.existsSync(file)) {
    console.error(`check-capability-parity: missing required file: ${file}`);
    process.exit(2);
  }
  return fs.readFileSync(file, "utf-8");
}

// ---------------------------------------------------------------------------
// The four registers
// ---------------------------------------------------------------------------

interface Registers {
  pages: string[];
  cards: Map<string, string>; // slug -> icon identifier used in the card
  homeImports: Set<string>; // identifiers imported from lucide-react
  /**
   * Local identifier -> the Lucide export it aliases. `Image as ImageIcon`
   * yields ImageIcon -> Image. The sidebar names the Lucide export directly
   * (`resolveIcon('Image')`), so comparing the card's local identifier against
   * it without resolving the alias reports a mismatch that is not one.
   */
  importAliases: Map<string, string>;
  bullets: Set<string>;
  sidebar: Map<string, string | null>; // slug -> resolveIcon('X') name, or null for a non-Lucide icon
}

function collect(): Registers {
  const pages = fs
    .readdirSync(CAPABILITIES_DIR)
    .filter((f) => f.endsWith(".mdx") && f !== "index.mdx")
    .map((f) => path.basename(f, ".mdx"))
    .sort();

  const home = readOrDie(HOME_MDX);
  const intro = readOrDie(INTRO_MDX);
  const tree = readOrDie(CUSTOM_TREE);

  // 2a. Cards, with the icon each one renders.
  const cards = new Map<string, string>();
  for (const m of home.matchAll(
    /<Card\s+href="\/ai-capabilities\/([^"]+)"[\s\S]*?<(\w+)\s+className="size-4/g,
  )) {
    cards.set(m[1]!, m[2]!);
  }

  // 2b. Identifiers imported from lucide-react. `Image as ImageIcon` is
  // aliased because a bare `Image` collides with the global in MDX scope; the
  // alias is the identifier the card must use.
  const homeImports = new Set<string>();
  const importAliases = new Map<string, string>();
  for (const m of home.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"]/g)) {
    for (const raw of m[1]!.split(",")) {
      const part = raw.trim();
      if (!part) continue;
      const alias = part.match(/^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/);
      if (alias) {
        homeImports.add(alias[2]!);
        importAliases.set(alias[2]!, alias[1]!);
      } else {
        homeImports.add(part);
        importAliases.set(part, part);
      }
    }
  }

  // 3. Bullets under "### AI tasks".
  const bullets = new Set<string>();
  for (const m of intro.matchAll(/\]\(\/ai-capabilities\/([^)#]+)\)/g)) {
    bullets.add(m[1]!);
  }

  // 4. Sidebar entries, with the Lucide icon name each one resolves.
  const sidebar = new Map<string, string | null>();
  for (const m of tree.matchAll(
    /url:\s*'\/ai-capabilities\/([^']+)',[\s\S]{0,200}?(?:icon:\s*(?:resolveIcon\('(\w+)'\)|React\.createElement\((\w+)))?[\s\S]{0,20}?\n\s*\}/g,
  )) {
    sidebar.set(m[1]!, m[2] ?? m[3] ?? null);
  }

  return { pages, cards, homeImports, importAliases, bullets, sidebar };
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

  for (const slug of r.pages) {
    if (!r.cards.has(slug)) {
      findings.push({
        slug,
        detail: `no <Card href="/ai-capabilities/${slug}"> in content/docs/index.mdx (the home grid)`,
        accepted: ACCEPTED_MISSING_CARD.has(slug),
      });
    }
    if (!r.bullets.has(slug)) {
      findings.push({
        slug,
        detail: `no bullet linking /ai-capabilities/${slug} under "### AI tasks" in introduction.mdx`,
        accepted: false,
      });
    }
    if (!r.sidebar.has(slug)) {
      findings.push({
        slug,
        detail: `no entry for /ai-capabilities/${slug} in src/lib/custom-tree.ts — the page would be reachable by URL and invisible in navigation`,
        accepted: false,
      });
    }
  }

  // Registrations pointing at a page that does not exist: a dead link, and the
  // reverse of the failure above.
  for (const [slug] of r.cards) {
    if (!pageSet.has(slug)) {
      findings.push({ slug, detail: "card in index.mdx points at a non-existent page", accepted: false });
    }
  }
  for (const slug of r.bullets) {
    if (!pageSet.has(slug)) {
      findings.push({ slug, detail: "bullet in introduction.mdx points at a non-existent page", accepted: false });
    }
  }
  for (const [slug] of r.sidebar) {
    if (!pageSet.has(slug)) {
      findings.push({ slug, detail: "sidebar entry in custom-tree.ts points at a non-existent page", accepted: false });
    }
  }

  // Icon consistency: the card icon must be imported (this one breaks the
  // build), and the card and the sidebar must show the same icon (this one
  // does not break anything, and is exactly why it needs checking).
  for (const [slug, icon] of r.cards) {
    if (!r.homeImports.has(icon)) {
      findings.push({
        slug,
        detail: `card renders <${icon}> but ${icon} is not imported from lucide-react in index.mdx — this breaks the build`,
        accepted: false,
      });
    }

    const sidebarIcon = r.sidebar.get(slug);
    const cardIcon = r.importAliases.get(icon) ?? icon;
    if (sidebarIcon && sidebarIcon !== cardIcon) {
      const shown = cardIcon === icon ? icon : `${icon} (alias of ${cardIcon})`;
      findings.push({
        slug,
        detail: `icon mismatch: card uses ${shown}, sidebar uses ${sidebarIcon}`,
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
        counts: {
          pages: registers.pages.length,
          cards: registers.cards.size,
          bullets: registers.bullets.size,
          sidebar: registers.sidebar.size,
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

console.log("=== AI capability registration parity ===\n");
console.log(`  pages    ${registers.pages.length}`);
console.log(`  cards    ${registers.cards.size}   (content/docs/index.mdx)`);
console.log(`  bullets  ${registers.bullets.size}   (introduction.mdx)`);
console.log(`  sidebar  ${registers.sidebar.size}   (src/lib/custom-tree.ts)\n`);

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
