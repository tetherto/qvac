#!/usr/bin/env bun
/**
 * Post-build splitter: reads `out/llm-md-manifest.json` (emitted by
 * `src/app/llm-md-manifest.json/route.ts` during `next build`) and writes one
 * Markdown file per non-archived page so AI agents can fetch any page's
 * Markdown by appending `.md` to its URL.
 *
 * Why a script instead of an `app/[[...slug]].md/route.ts`?
 *   - `output: 'export'` does not support `rewrites()`, ruling out the
 *     fumadocs guide's `/docs/:path*.md` → `/llms.mdx/docs/:path*` approach.
 *   - Next.js dynamic route segments cannot include `.md` in their names
 *     (`[[...slug]].md` is invalid), so the markdown route would have to
 *     live under a sibling tree (e.g. `app/llms.mdx/[[...slug]]`) and be
 *     re-homed by a post-build move. That tree's exact output paths under
 *     `output: 'export'` are undocumented and brittle.
 *
 * A JSON manifest emitted by a regular route handler is predictable, and
 * this script handles the layout entirely in user-space.
 *
 * URL → file mapping:
 *   '/'                            → out/index.md
 *   '/quickstart'                  → out/quickstart.md
 *   '/reference/api'               → out/reference/api.md
 *   '/reference/api/v0.10.x'       → out/reference/api/v0.10.x.md  (archived)
 *
 * Archived per-section versions ARE included in the manifest. The HTML
 * for those pages renders publicly (with `noindex` + canonical-to-latest
 * for SEO posture); the per-page `.md` is just its Markdown
 * representation, so it must exist for the in-page "Copy as Markdown"
 * action and the `Accept: text/markdown` content-negotiation flow
 * (configured in `public/_redirects`) to resolve cleanly. The aggregate
 * catalogs (`llms.txt`, `llms-full.txt`, `sitemap.xml`) keep filtering
 * archives — see the comment in `llm-md-manifest.json/route.ts` for the
 * rationale.
 *
 * Usage (invoked from `package.json` after `next build`):
 *   bun run scripts/generate-llm-md-files.ts
 */

import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCS_WEBSITE_DIR = path.resolve(SCRIPT_DIR, "..");
const OUT_DIR = path.join(DOCS_WEBSITE_DIR, "out");
const MANIFEST_PATH = path.join(OUT_DIR, "llm-md-manifest.json");

interface ManifestEntry {
  url: string;
  slugs: string[];
  content: string;
}

/**
 * Maps a page URL (as exposed by fumadocs' `page.url`) to its post-build
 * Markdown destination, relative to `out/`. Pure / side-effect free for
 * unit testing.
 *
 *   '/'              → 'index.md'
 *   '/quickstart'    → 'quickstart.md'
 *   '/quickstart/'   → 'quickstart.md'   (trailing slash tolerated)
 *   '/reference/api' → 'reference/api.md'
 */
export function urlToMarkdownRelativePath(url: string): string {
  if (typeof url !== "string" || url.length === 0) {
    throw new Error(`Invalid manifest entry url: ${JSON.stringify(url)}`);
  }
  const trimmed = url.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed.length === 0) return "index.md";
  return `${trimmed}.md`;
}

async function readManifest(): Promise<ManifestEntry[]> {
  const raw = await fs.readFile(MANIFEST_PATH, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Expected manifest to be an array, got: ${typeof parsed}`,
    );
  }
  return parsed as ManifestEntry[];
}

async function writeEntry(entry: ManifestEntry): Promise<string> {
  const rel = urlToMarkdownRelativePath(entry.url);
  const target = path.join(OUT_DIR, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, entry.content, "utf-8");
  return rel;
}

async function main(): Promise<void> {
  console.log(`📄 Generating per-page .md files from ${MANIFEST_PATH}…`);

  let entries: ManifestEntry[];
  try {
    entries = await readManifest();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not read ${MANIFEST_PATH}: ${msg}. Did \`next build\` run first?`,
    );
  }

  if (entries.length === 0) {
    console.warn(
      "   ⚠️  Manifest is empty — no .md files will be written.",
    );
  }

  for (const entry of entries) {
    const rel = await writeEntry(entry);
    console.log(`   wrote out/${rel}`);
  }

  await fs.unlink(MANIFEST_PATH);
  console.log(`   removed ${MANIFEST_PATH}`);

  console.log(`✅ Wrote ${entries.length} .md file(s)`);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error) => {
    console.error("❌ Error generating .md files:", error.message);
    if (error.stack) console.error(error.stack);
    process.exit(1);
  });
}
