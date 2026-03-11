#!/usr/bin/env bun
/**
 * Orchestrates full docs generation: reads SDK version from the monorepo,
 * generates API docs via TypeDoc, and updates the version list.
 *
 * Usage: bun run scripts/run-docs-generate.ts
 *
 * Expects to run from docs/website/ inside the monorepo.
 * Set SDK_PATH to override the SDK location (default: ../../packages/qvac-sdk).
 */

import { execSync } from "child_process";
import { readFileSync } from "fs";
import { resolve } from "path";

const sdkPkgPath = resolve(
  process.cwd(),
  "../../packages/qvac-sdk/package.json"
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
  console.error("No version field in packages/qvac-sdk/package.json");
  process.exit(1);
}

const sdkPath =
  process.env.SDK_PATH || resolve(process.cwd(), "../../packages/qvac-sdk");

console.log(`SDK version: ${version}`);
console.log(`SDK path:    ${sdkPath}`);

execSync(`bun run scripts/generate-api-docs.ts ${version}`, {
  stdio: "inherit",
  env: { ...process.env, SDK_PATH: sdkPath },
});

execSync(`bun run scripts/update-versions-list.ts ${version}`, {
  stdio: "inherit",
});

console.log("docs:generate complete");
