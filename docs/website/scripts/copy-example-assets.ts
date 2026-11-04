#!/usr/bin/env bun
/**
 * Copy the companion data files of the SDK examples into the transpiled tree.
 *
 * Usage: bun run scripts/copy-example-assets.ts
 *
 * `prebuild:examples` runs `tsc` over the example sources, and `tsc` emits
 * only what it compiles. Any file an example opens at runtime — a dataset, a
 * sample audio file, an image — therefore exists next to the `.ts` source but
 * not next to the `.js` the JavaScript tabs embed, so a reader who runs the
 * compiled example in place hits a missing file. Copying them keeps both trees
 * runnable from the example's own directory, which is how the examples resolve
 * their companions.
 *
 * Sources (`.ts`, `.js`) and prose (`.md`) are skipped: the first two are what
 * the transpilation itself owns, and the third is never read at runtime.
 */

import * as fs from "fs/promises";
import * as path from "path";

const DOCS_DIR = process.cwd();
const MONOREPO_ROOT = path.resolve(DOCS_DIR, "../..");
const EXAMPLES_DIR = path.join(MONOREPO_ROOT, "packages", "sdk", "examples");
const OUT_DIR = path.join(MONOREPO_ROOT, "packages", "sdk", "dist", "examples");

const SKIP_EXTENSIONS = new Set([".ts", ".js", ".md"]);

async function collectAssets(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const assets: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      assets.push(...(await collectAssets(entryPath)));
    } else if (!SKIP_EXTENSIONS.has(path.extname(entry.name))) {
      assets.push(entryPath);
    }
  }

  return assets;
}

async function main(): Promise<void> {
  const assets = await collectAssets(EXAMPLES_DIR);

  for (const asset of assets) {
    const target = path.join(OUT_DIR, path.relative(EXAMPLES_DIR, asset));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(asset, target);
  }

  console.log(`Copied ${assets.length} example asset(s) to dist/examples`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
