#!/usr/bin/env node
/**
 * Assert @qvac/bare-sdk's dep manifest stays in lockstep with sibling
 * @qvac/sdk's across dependencies, optionalDependencies, and
 * peerDependencies. Run as part of bare-sdk's build.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_ADDONS } from "./plugin-addons.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bareSdkPkgPath = path.resolve(__dirname, "..", "package.json");
const sdkPkgPath = path.resolve(__dirname, "..", "..", "sdk", "package.json");

const bareSdkPkg = JSON.parse(fs.readFileSync(bareSdkPkgPath, "utf8"));
const sdkPkg = JSON.parse(fs.readFileSync(sdkPkgPath, "utf8"));

const DEP_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];
// Packages sdk declares but bare-sdk deliberately omits because they are never
// reached on bare:
//   - bare-runtime: only imported by node-rpc-client (the Node host path that
//     spawns `bare`); bare-sdk pins `#rpc` to bare-client, so it's unused.
//     Dropping it also avoids pulling its ~80MB of per-platform bare prebuilds.
//   - bare-pack: only used by the Node-side `bundle` command, lazily resolved.
const SDK_ONLY_PACKAGES = new Set(["bare-runtime", "bare-pack"]);

const errors = [];

// Subset + version match across all dep fields.
for (const field of DEP_FIELDS) {
  const bareDeps = bareSdkPkg[field] ?? {};
  const sdkDeps = sdkPkg[field] ?? {};
  for (const [name, range] of Object.entries(bareDeps)) {
    if (!(name in sdkDeps)) continue;
    if (sdkDeps[name] !== range) {
      errors.push(
        `version drift on ${field}."${name}": sdk has "${sdkDeps[name]}", bare-sdk has "${range}".`,
      );
    }
  }
}

// Missing-dep on `dependencies` only. opt/peer drift is dominated by
// Expo/Pear/RN packages that bare-sdk excludes from its bundle, and
// addon leaks via opt/peer are caught by check-no-addon-deps.mjs.
const sdkDeps = sdkPkg.dependencies ?? {};
const bareSdkDeps = bareSdkPkg.dependencies ?? {};
for (const [name, range] of Object.entries(sdkDeps)) {
  if (PLUGIN_ADDONS.has(name)) continue;
  if (SDK_ONLY_PACKAGES.has(name)) continue;
  if (!(name in bareSdkDeps)) {
    errors.push(
      `missing dep "${name}":"${range}" — sdk declares it, bare-sdk does not. Mirror it or add to SDK_ONLY_PACKAGES.`,
    );
  }
}

// No extras across all dep fields.
for (const field of DEP_FIELDS) {
  const bareDeps = bareSdkPkg[field] ?? {};
  const sdkDeps = sdkPkg[field] ?? {};
  for (const name of Object.keys(bareDeps)) {
    if (name in sdkDeps) continue;
    errors.push(
      `extra ${field}."${name}" — bare-sdk declares it, sdk does not.`,
    );
  }
}

if (errors.length > 0) {
  console.error(`[check-deps-vs-sdk] FAIL:`);
  for (const err of errors) console.error(`  - ${err}`);
  process.exit(1);
}

const summary = DEP_FIELDS.map(
  (f) => `${f}=${Object.keys(bareSdkPkg[f] ?? {}).length}`,
).join(", ");
console.log(`[check-deps-vs-sdk] OK: ${summary}`);
