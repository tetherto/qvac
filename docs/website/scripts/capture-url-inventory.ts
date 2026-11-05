#!/usr/bin/env bun
/**
 * Captures the set of URLs the built site serves, into a fixture that later
 * survives the collections reorganization as the definition of "what used to
 * resolve".
 *
 * The reorganization puts a collection name in front of every path, so every
 * page URL changes and each one needs a redirect. Hand-listing 69 URLs invites
 * omissions, and a missed entry silently 404s a URL that search engines and
 * external links already point at. Capturing the set from a real build before
 * anything moves, and replaying it against the built site afterwards, turns
 * that risk into a failing check.
 *
 * Two surfaces are captured, because both are public entry points:
 *   - `pages`    — the HTML routes, derived from the exported `index.html` files
 *   - `markdown` — the per-page `.md` twins written by generate-llm-md-files.ts,
 *                  which agents fetch by appending `.md` to any page URL
 *
 * `sitemap.xml` is not stored: it is a filtered view of `pages` (archived
 * per-version pages are deliberately excluded from it), so it is verified as a
 * subset at capture time instead of being duplicated in the fixture.
 *
 * The output is sorted and carries no timestamp, so re-running it on an
 * unchanged build produces no diff.
 *
 * Usage (after `npm run build`):
 *   bun run scripts/capture-url-inventory.ts
 */

import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCS_WEBSITE_DIR = path.resolve(SCRIPT_DIR, "..");
const OUT_DIR = path.join(DOCS_WEBSITE_DIR, "out");
const FIXTURE_PATH = path.join(
  DOCS_WEBSITE_DIR,
  "tests",
  "fixtures",
  "pre-move-urls.json",
);

/**
 * Route directories that exist to serve errors, not content. They have no
 * pre-move URL to preserve.
 */
const NON_CONTENT_ROUTES = new Set(["/404", "/_not-found"]);

export interface UrlInventory {
  pages: string[];
  markdown: string[];
}

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

/**
 * `out/index.html` → `/`, `out/installation/index.html` → `/installation`.
 * A bare `out/404.html` has no directory of its own, so it is filtered by
 * suffix rather than by route name.
 */
export function toPageUrl(relativePath: string): string | null {
  if (!relativePath.endsWith("index.html")) return null;
  const dir = path.dirname(relativePath);
  const url = dir === "." ? "/" : `/${dir}`;
  return NON_CONTENT_ROUTES.has(url) ? null : url;
}

export function toMarkdownUrl(relativePath: string): string | null {
  if (!relativePath.endsWith(".md")) return null;
  return `/${relativePath}`;
}

function sitemapUrlPaths(xml: string): string[] {
  const locs = xml.match(/<loc>([^<]+)<\/loc>/g) ?? [];
  return locs.map((loc) => {
    const raw = loc.replace(/<\/?loc>/g, "");
    const url = new URL(raw);
    return url.pathname === "/" ? "/" : url.pathname.replace(/\/$/, "");
  });
}

async function main() {
  let files: string[];
  try {
    files = await walk(OUT_DIR);
  } catch {
    throw new Error(
      `No build output at ${OUT_DIR}. Run \`npm run build\` before capturing.`,
    );
  }

  const relative = files.map((file) => path.relative(OUT_DIR, file));
  const pages = relative
    .map(toPageUrl)
    .filter((url): url is string => url !== null)
    .sort();
  const markdown = relative
    .map(toMarkdownUrl)
    .filter((url): url is string => url !== null)
    .sort();

  if (pages.length === 0) {
    throw new Error(`No page URLs found under ${OUT_DIR}; is the build stale?`);
  }

  const sitemapPath = path.join(OUT_DIR, "sitemap.xml");
  const sitemap = sitemapUrlPaths(await fs.readFile(sitemapPath, "utf-8"));
  const pageSet = new Set(pages);
  const strays = sitemap.filter((url) => !pageSet.has(url));
  if (strays.length > 0) {
    throw new Error(
      `sitemap.xml lists ${strays.length} URL(s) with no exported page:\n  ${strays.join("\n  ")}`,
    );
  }

  const inventory: UrlInventory = { pages, markdown };
  await fs.mkdir(path.dirname(FIXTURE_PATH), { recursive: true });
  await fs.writeFile(
    FIXTURE_PATH,
    `${JSON.stringify(inventory, null, 2)}\n`,
    "utf-8",
  );

  console.log(
    `Captured ${pages.length} page URL(s) and ${markdown.length} markdown URL(s)`,
  );
  console.log(`  ${sitemap.length} of them are listed in sitemap.xml`);
  console.log(`Wrote ${path.relative(DOCS_WEBSITE_DIR, FIXTURE_PATH)}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
