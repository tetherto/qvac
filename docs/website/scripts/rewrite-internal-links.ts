#!/usr/bin/env bun
/**
 * Repoints every internal link at the page's post-move URL.
 *
 * The redirects generated for the collections reorganization keep old links
 * working for the outside world, but a link inside the site has no excuse to
 * take a redirect hop: it costs a round trip, and it lets the old URL live on
 * in content long after the move.
 *
 * A link is rewritten only when its path matches a pre-move page URL exactly,
 * which is what keeps the pass from touching unrelated absolute strings —
 * `/favicon.ico`, filesystem paths in code samples, anything the move mapping
 * never claimed. Anchors and query strings ride along untouched.
 *
 * Links to `/` are left alone: as a bare token it is far too common to match
 * safely, and the handful of real home links are handled by hand.
 *
 * Usage:
 *   bun run scripts/rewrite-internal-links.ts           # rewrite in place
 *   bun run scripts/rewrite-internal-links.ts --check   # fail if any remain
 */

import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "node:url";
import { loadMoveMap } from "./collections-move-map.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCS_WEBSITE_DIR = path.resolve(SCRIPT_DIR, "..");

/** Roots scanned, and the extensions worth scanning in each. */
const SCAN = [
  { dir: path.join(DOCS_WEBSITE_DIR, "content", "docs"), ext: [".mdx"] },
  { dir: path.join(DOCS_WEBSITE_DIR, "src"), ext: [".ts", ".tsx"] },
];

/**
 * The syntaxes an internal link is written in here: Markdown targets, JSX
 * attributes, and the object literals that feed components a link.
 */
const LINK_RE =
  /(\]\(|href=["'`]|(?:href|url|downloadLink)\s*:\s*["'`])(\/[^\s"'`)\]}<>]*)/g;

interface Rewrite {
  file: string;
  from: string;
  to: string;
}

/** `/quickstart/#install` → base `/quickstart`, suffix `#install`. */
function splitTarget(target: string): { base: string; suffix: string } {
  const cut = target.search(/[#?]/);
  const base = cut === -1 ? target : target.slice(0, cut);
  const suffix = cut === -1 ? "" : target.slice(cut);
  return { base: base.replace(/\/$/, "") || "/", suffix };
}

export function rewriteText(
  text: string,
  urlMap: Map<string, string>,
): { text: string; hits: Array<{ from: string; to: string }> } {
  const hits: Array<{ from: string; to: string }> = [];
  const next = text.replace(
    LINK_RE,
    (match, prefix: string, target: string) => {
      const { base, suffix } = splitTarget(target);
      const destination = urlMap.get(base);
      if (!destination) return match;
      const trailingSlash =
        base !== "/" && target.slice(base.length).startsWith("/");
      const rebuilt = `${destination}${trailingSlash ? "/" : ""}${suffix}`;
      hits.push({ from: target, to: rebuilt });
      return `${prefix}${rebuilt}`;
    },
  );
  return { text: next, hits };
}

async function filesToScan(): Promise<string[]> {
  const found: string[] = [];
  for (const { dir, ext } of SCAN) {
    const entries = await fs.readdir(dir, {
      withFileTypes: true,
      recursive: true,
    });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!ext.includes(path.extname(entry.name))) continue;
      found.push(path.join(entry.parentPath, entry.name));
    }
  }
  return found.sort();
}

async function main() {
  const check = process.argv.includes("--check");
  const moves = await loadMoveMap();
  const urlMap = new Map(
    moves
      .filter((move) => move.fromUrl !== "/")
      .map((move) => [move.fromUrl, move.toUrl]),
  );

  const rewrites: Rewrite[] = [];
  for (const file of await filesToScan()) {
    const original = await fs.readFile(file, "utf-8");
    const { text, hits } = rewriteText(original, urlMap);
    if (hits.length === 0) continue;
    for (const hit of hits) {
      rewrites.push({ file: path.relative(DOCS_WEBSITE_DIR, file), ...hit });
    }
    if (!check) await fs.writeFile(file, text, "utf-8");
  }

  if (rewrites.length === 0) {
    console.log("No internal link points at a pre-move URL");
    return;
  }

  const byFile = new Map<string, number>();
  for (const rewrite of rewrites) {
    byFile.set(rewrite.file, (byFile.get(rewrite.file) ?? 0) + 1);
  }

  if (check) {
    console.error(
      `${rewrites.length} internal link(s) still point at a pre-move URL, in ${byFile.size} file(s):`,
    );
    for (const [file, count] of byFile) console.error(`  ${file} (${count})`);
    process.exit(1);
  }

  console.log(
    `Rewrote ${rewrites.length} internal link(s) across ${byFile.size} file(s)`,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
