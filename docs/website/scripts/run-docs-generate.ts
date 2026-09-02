#!/usr/bin/env bun
/**
 * Orchestrates full docs generation: reads SDK version from the monorepo,
 * generates API docs via TypeDoc, and updates the version list.
 *
 * Usage: bun run scripts/run-docs-generate.ts
 *
 * Expects to run from docs/website/ inside the monorepo.
 * Set SDK_PATH to override the SDK location (default: ../../packages/sdk).
 */

import { execSync } from "child_process";
import { readFileSync } from "fs";
import { resolve } from "path";

const sdkPkgPath = resolve(
  process.cwd(),
  "../../packages/sdk/package.json"
);

let version: string;
try {
  const pkg = JSON.parse(readFileSync(sdkPkgPath, "utf-8"));
  version = pkg.version;
} catch {
  console.error(`Could not read ${sdkPkgPath}`);
  process.exit(1);
}

if (!version) {
  console.error("No version field in packages/sdk/package.json");
  process.exit(1);
}

const sdkPath =
  process.env.SDK_PATH || resolve(process.cwd(), "../../packages/sdk");

console.log(`SDK version: ${version}`);
console.log(`SDK path:    ${sdkPath}`);

// The generator always writes to v<X.Y>.x.mdx now — the current latest
// included. This is a preview-only regen (no shim rewrite, no _redirects
// touch, no release orchestration) so it happily overwrites the current
// series page in place; a follow-up `release-version-minor.ts` run is
// what refreshes the shim + `_redirects` block on a real minor rotation.
execSync(`bun run scripts/generate-api-docs.ts ${version}`, {
  stdio: "inherit",
  env: { ...process.env, SDK_PATH: sdkPath },
});

execSync(`bun run scripts/update-versions-list.ts --latest=${version}`, {
  stdio: "inherit",
});

console.log("docs:generate complete");
