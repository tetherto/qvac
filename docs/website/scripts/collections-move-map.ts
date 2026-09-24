#!/usr/bin/env bun
/**
 * The single source of truth for the collections reorganization: which
 * content file goes where, and therefore which URL redirects to which.
 *
 * Both consumers read this module — the move itself, and the `_redirects`
 * generation that follows it. Deriving them from one mapping is what keeps a
 * page from being moved without a redirect, or redirected to a path nothing
 * was moved to.
 *
 * The mapping is expressed as a handful of rules rather than 69 hand-listed
 * pairs, and materialized by walking the real content tree. A hand-listed set
 * would silently omit whatever it forgot; walking the tree cannot, because
 * every file it finds must be claimed by exactly one rule or the run fails.
 *
 * The rules are deliberately mechanical: a page keeps its path and gains its
 * collection as a prefix. Only three deviations exist, each because the
 * destination is a collection landing page or because the old prefix belonged
 * to a different collection — see COLLECTION_OF and the overview constants.
 *
 * The materialized mapping is written to a fixture on first run, because the
 * rules can only be materialized against the pre-move tree: once the pages
 * move, walking `content/docs` no longer describes where they came from. The
 * redirect generation runs after the move and reads that fixture, so the
 * mapping outlives the tree it was derived from.
 *
 * Usage:
 *   bun run scripts/collections-move-map.ts                       # print the mapping
 *   bun run scripts/collections-move-map.ts --apply               # git mv everything
 *   bun run scripts/collections-move-map.ts --apply --only sdk    # one collection
 */

import * as fs from "fs/promises";
import * as path from "path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCS_WEBSITE_DIR = path.resolve(SCRIPT_DIR, "..");
const CONTENT_DIR = path.join(DOCS_WEBSITE_DIR, "content", "docs");
const FIXTURE_PATH = path.join(
  DOCS_WEBSITE_DIR,
  "tests",
  "fixtures",
  "collections-move-map.json",
);

export type Collection = "ecosystem" | "sdk" | "cli" | "resources";

export interface Move {
  collection: Collection;
  /** Path under `content/docs`, before the move. */
  from: string;
  /** Path under `content/docs`, after the move. */
  to: string;
  /** URL the page served before the move. */
  fromUrl: string;
  /** URL the page serves after the move. */
  toUrl: string;
}

/**
 * Which collection claims a path, tried in order — first match wins, and
 * anything unclaimed belongs to the SDK, which is the collection that
 * inherits every page no other one asks for.
 *
 * The whole `cli/` tree — the CLI page and the HTTP server pages under it —
 * becomes the CLI collection, which is where it already sat before the move.
 */
const COLLECTION_OF: Array<{ prefix: string; collection: Collection }> = [
  { prefix: "index.mdx", collection: "ecosystem" },
  { prefix: "addons/", collection: "ecosystem" },
  { prefix: "cli/", collection: "cli" },
];

/**
 * Pages whose destination the prefix rule cannot derive: the two that become
 * a collection's landing page, and the one that changes collection outright —
 * `how-it-works` documents the SDK, so it moves into the SDK and drops the
 * `about/` segment on the way. Everything else keeps the path it has today,
 * under its collection.
 */
const EXPLICIT_DESTINATION: Record<string, string> = {
  "index.mdx": "ecosystem/index.mdx",
  "introduction.mdx": "sdk/index.mdx",
  "about/how-it-works.mdx": "sdk/how-it-works.mdx",
};

/**
 * Pages that leave the published set instead of moving into a collection.
 * They document no distributable, so they have no destination to redirect
 * to; `public/_redirects` sends their URLs to the Ecosystem overview by hand.
 */
const RETIRED = new Set(["about/vision.mdx", "about/public-launch.mdx"]);

/**
 * The CLI collection is the one folder that already carries its collection's
 * name, so its pages keep the path they have rather than gaining a prefix.
 */
const SELF_PREFIXED = "cli/";

export function collectionOf(contentPath: string): Collection {
  for (const { prefix, collection } of COLLECTION_OF) {
    if (contentPath === prefix || contentPath.startsWith(prefix)) {
      return collection;
    }
  }
  return "sdk";
}

export function destinationOf(contentPath: string): string {
  const explicit = EXPLICIT_DESTINATION[contentPath];
  if (explicit) return explicit;

  if (contentPath.startsWith(SELF_PREFIXED)) return contentPath;

  return `${collectionOf(contentPath)}/${contentPath}`;
}

/**
 * `index.mdx` → `/`, `sdk/index.mdx` → `/sdk`, `sdk/quickstart.mdx` →
 * `/sdk/quickstart`. Mirrors how the loader derives a URL from a file, with
 * `baseUrl: '/'`.
 */
export function contentPathToUrl(contentPath: string): string {
  const withoutExtension = contentPath.replace(/\.mdx$/, "");
  const withoutIndex = withoutExtension.replace(/(^|\/)index$/, "");
  return withoutIndex === "" ? "/" : `/${withoutIndex}`;
}

async function walkMdx(dir: string, base = dir): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkMdx(full, base)));
    } else if (entry.name.endsWith(".mdx")) {
      files.push(path.relative(base, full));
    }
  }
  return files;
}

/**
 * Reads the pre-move content tree and returns one entry per page. Throws once
 * any page sits in a collection, since from that point the tree no longer
 * describes where pages came from — use `loadMoveMap` instead.
 */
export async function buildMoveMap(): Promise<Move[]> {
  const files = (await walkMdx(CONTENT_DIR))
    .filter((file) => !RETIRED.has(file))
    .sort();
  // `cli` is absent on purpose: a `cli/` folder is what the pre-move tree
  // looks like, not evidence that the move already ran.
  const collections = new Set<string>(["ecosystem", "sdk", "resources"]);

  const alreadyMoved = files.filter((file) =>
    collections.has(file.split("/")[0]!),
  );
  if (alreadyMoved.length > 0) {
    throw new Error(
      `${alreadyMoved.length} page(s) already live in a collection; the move looks partially applied:\n  ${alreadyMoved.join("\n  ")}`,
    );
  }

  const moves = files.map((from) => {
    const to = destinationOf(from);
    return {
      collection: collectionOf(from),
      from,
      to,
      fromUrl: contentPathToUrl(from),
      toUrl: contentPathToUrl(to),
    };
  });

  const destinations = new Set<string>();
  for (const move of moves) {
    if (destinations.has(move.to)) {
      throw new Error(`Two pages map to the same destination: ${move.to}`);
    }
    destinations.add(move.to);
  }

  return moves;
}

/**
 * The mapping as every consumer should read it: materialized from the tree
 * the first time, from the fixture afterwards. Callers that run after the
 * move — the redirect generation — get the same answer as callers that ran
 * before it.
 */
export async function loadMoveMap(): Promise<Move[]> {
  try {
    return JSON.parse(await fs.readFile(FIXTURE_PATH, "utf-8")) as Move[];
  } catch {
    const moves = await buildMoveMap();
    await fs.mkdir(path.dirname(FIXTURE_PATH), { recursive: true });
    await fs.writeFile(
      FIXTURE_PATH,
      `${JSON.stringify(moves, null, 2)}\n`,
      "utf-8",
    );
    return moves;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Applies the moves that are still pending. Entries whose source is gone and
 * whose destination is present were applied by an earlier run — the move
 * lands one collection at a time — so they are skipped rather than failed.
 */
async function applyMoves(moves: Move[]): Promise<number> {
  let applied = 0;
  for (const move of moves) {
    const from = path.join(CONTENT_DIR, move.from);
    const to = path.join(CONTENT_DIR, move.to);

    if (!(await exists(from))) {
      if (await exists(to)) continue;
      throw new Error(`${move.from} is missing, and so is its destination`);
    }

    await fs.mkdir(path.dirname(to), { recursive: true });
    execFileSync("git", ["mv", move.from, move.to], { cwd: CONTENT_DIR });
    applied += 1;
  }
  await pruneEmptyDirectories(CONTENT_DIR);
  return applied;
}

/**
 * git tracks files, not directories, so the folders a move empties stay on
 * disk and would leave the content tree looking like it still has an
 * `about/` or a `cli/` at its root.
 */
async function pruneEmptyDirectories(dir: string): Promise<boolean> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  let empty = true;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      empty = false;
      continue;
    }
    const child = path.join(dir, entry.name);
    if (await pruneEmptyDirectories(child)) {
      await fs.rmdir(child);
    } else {
      empty = false;
    }
  }
  return empty;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const onlyIndex = args.indexOf("--only");
  const only = onlyIndex === -1 ? null : (args[onlyIndex + 1] as Collection);

  const all = await loadMoveMap();
  const moves = only ? all.filter((move) => move.collection === only) : all;

  if (only && moves.length === 0) {
    throw new Error(`No page maps to collection '${only}'`);
  }

  for (const move of moves) {
    console.log(`${move.fromUrl}  ->  ${move.toUrl}`);
  }

  const counts = new Map<Collection, number>();
  for (const move of moves) {
    counts.set(move.collection, (counts.get(move.collection) ?? 0) + 1);
  }
  const summary = [...counts]
    .map(([collection, count]) => `${collection} ${count}`)
    .join(", ");
  console.log(`\n${moves.length} page(s): ${summary}`);

  if (apply) {
    const applied = await applyMoves(moves);
    console.log(
      `Moved ${applied} page(s) with git mv, skipped ${moves.length - applied} already in place`,
    );
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
