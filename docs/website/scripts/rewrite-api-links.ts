#!/usr/bin/env bun
/**
 * One-time link rewriter: convert legacy per-function API URLs into
 * single-page anchors.
 *
 * Examples:
 *   /sdk/api/loadModel   →  /sdk/api#loadmodel
 *   /sdk/api/loadModel/  →  /sdk/api#loadmodel
 *   /sdk/api/profiler    →  /sdk/api#profiler
 *   /sdk/api/errors      →  /sdk/api#errors
 *
 * Per-function URLs that point to functions excluded from the new summary
 * scope (e.g. `close`, `getLogger`) become a plain `/sdk/api` link — the
 * page itself documents the explicit exclusion in its callout.
 *
 * Usage:
 *   bun run scripts/rewrite-api-links.ts            # apply changes
 *   bun run scripts/rewrite-api-links.ts --dry-run  # preview
 */

import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = path.resolve(SCRIPT_DIR, "..", "content", "docs");

/** Functions that DO have a `### name` anchor on the new summary page. */
const SCOPED_FUNCTIONS = new Set([
  "cancel",
  "completion",
  "deleteCache",
  "diffusion",
  "downloadAsset",
  "embed",
  "finetune",
  "getModelInfo",
  "heartbeat",
  "invokePlugin",
  "invokePluginStream",
  "loadModel",
  "loggingStream",
  "modelRegistryGetModel",
  "modelRegistryList",
  "modelRegistrySearch",
  "ocr",
  "ragChunk",
  "ragCloseWorkspace",
  "ragDeleteEmbeddings",
  "ragDeleteWorkspace",
  "ragIngest",
  "ragListWorkspaces",
  "ragReindex",
  "ragSaveEmbeddings",
  "ragSearch",
  "resume",
  "startQVACProvider",
  "state",
  "stopQVACProvider",
  "suspend",
  "textToSpeech",
  "transcribe",
  "transcribeStream",
  "translate",
  "unloadModel",
]);

/** Curated objects with their own anchor on the summary page. */
const SCOPED_OBJECTS = new Set(["profiler"]);

function rewriteSlug(slug: string): string {
  if (slug === "errors") return "#errors";
  if (SCOPED_FUNCTIONS.has(slug)) return `#${slug.toLowerCase()}`;
  if (SCOPED_OBJECTS.has(slug)) return `#${slug.toLowerCase()}`;
  // Out-of-scope or unknown — drop to the bare page; the summary's intro
  // callout explains where these live now.
  return "";
}

function rewriteContent(content: string): { content: string; rewrites: number } {
  let rewrites = 0;
  // Match `/sdk/api/<slug>` optionally followed by `/`, then optionally a
  // legacy fragment (`#anything`). The legacy fragments referenced
  // sub-sections within a per-function page that no longer exist in the
  // single-page format, so we drop them and point at the function anchor.
  const re = /\/sdk\/api\/([A-Za-z][A-Za-z0-9_-]*)\/?(#[A-Za-z0-9_-]+)?(?=[)"'\s\]>?,.;]|$)/g;
  const result = content.replace(re, (_full, slug: string, _legacyFragment?: string) => {
    const anchor = rewriteSlug(slug);
    rewrites++;
    return `/sdk/api${anchor}`;
  });
  return { content: result, rewrites };
}

async function walk(dir: string, files: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, files);
    } else if (entry.name.endsWith(".mdx") || entry.name.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const files = await walk(CONTENT_DIR);
  let totalRewrites = 0;
  let touchedFiles = 0;

  for (const file of files) {
    // Skip the API summary itself — its frontmatter contains examples that
    // legitimately reference its own anchors and we don't want to touch
    // those hand-curated mentions.
    const rel = path.relative(CONTENT_DIR, file);
    if (rel.startsWith("sdk" + path.sep + "api")) continue;

    const original = await fs.readFile(file, "utf-8");
    const { content: rewritten, rewrites } = rewriteContent(original);
    if (rewrites === 0) continue;

    totalRewrites += rewrites;
    touchedFiles += 1;
    console.log(`  ${dryRun ? "[dry-run] " : ""}${rel}: ${rewrites} link(s)`);
    if (!dryRun) await fs.writeFile(file, rewritten, "utf-8");
  }

  console.log(``);
  console.log(
    `${dryRun ? "Would rewrite" : "Rewrote"} ${totalRewrites} link(s) ` +
      `across ${touchedFiles} file(s).`,
  );
}

main().catch((err) => {
  console.error("❌ Failed:", err);
  process.exit(1);
});
