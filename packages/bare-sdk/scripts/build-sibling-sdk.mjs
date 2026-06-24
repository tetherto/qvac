#!/usr/bin/env node
// Build the sibling @qvac/sdk so `bundle-from-sdk` has a populated ../sdk/dist
// to copy. Compile-only (tsc + aliases, no eslint) so a bare-sdk PR isn't
// coupled to sdk lint health. No-op outside the monorepo or when dist is fresh.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sdkDir = path.resolve(here, "..", "..", "sdk");
const sdkPkg = path.join(sdkDir, "package.json");
const builtMarker = path.join(sdkDir, "dist", "index.js");

function isMonorepoSibling() {
  try {
    return JSON.parse(fs.readFileSync(sdkPkg, "utf8")).name === "@qvac/sdk";
  } catch {
    return false;
  }
}

// Skip the rebuild when the marker is newer than every tracked source file
// under packages/sdk (walk everything except node_modules / dist / .cache).
function alreadyBuilt() {
  let markerMtime;
  try {
    markerMtime = fs.statSync(builtMarker).mtimeMs;
  } catch {
    return false;
  }

  const skip = new Set(["node_modules", "dist", ".cache"]);
  const stack = [sdkDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      let mtime;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        continue;
      }
      if (mtime > markerMtime) return false;
    }
  }
  return true;
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: sdkDir, stdio: "inherit" });
  if (result.error) {
    console.error(`[build-sibling-sdk] failed to spawn '${cmd}': ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[build-sibling-sdk] ${cmd} ${args.join(" ")} failed in ${sdkDir}`);
    process.exit(result.status ?? 1);
  }
}

if (!isMonorepoSibling()) {
  process.exit(0);
}

if (alreadyBuilt()) {
  console.log("[build-sibling-sdk] @qvac/sdk dist is up to date, skipping rebuild");
  process.exit(0);
}

console.log("[build-sibling-sdk] Building sibling @qvac/sdk at", sdkDir);
run("bun", ["install"]);
// Compile half of sdk's build (tsc + aliases), no lint.
fs.rmSync(path.join(sdkDir, "dist"), { recursive: true, force: true });
run(path.join(sdkDir, "node_modules", ".bin", "tsc"), ["--project", "tsconfig.json"]);
run("bun", ["run", "postcompile:aliases"]);
