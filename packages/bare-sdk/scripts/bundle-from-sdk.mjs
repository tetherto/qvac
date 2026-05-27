#!/usr/bin/env node
/**
 * Bundle @qvac/bare-sdk's dist/_sdk/ from sibling @qvac/sdk's compiled
 * dist/. Excludes server/worker.js (consumers assemble plugins
 * explicitly) and pear/pre.js (Pear apps author their own entry).
 *
 * NOTICE auto-copies from sibling sdk on every build (gitignored).
 * LICENSE is committed and verified against sdk via a fail-fast diff.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bareSdkRoot = path.resolve(__dirname, "..");
const sdkDist = path.resolve(bareSdkRoot, "..", "sdk", "dist");
const destRoot = path.resolve(bareSdkRoot, "dist", "_sdk");

if (!fs.existsSync(sdkDist)) {
  console.error(
    `[bundle-from-sdk] sibling sdk dist not found at ${sdkDist}. ` +
      `Run \`bun run build\` in packages/sdk first.`,
  );
  process.exit(1);
}

if (fs.existsSync(destRoot)) {
  fs.rmSync(destRoot, { recursive: true, force: true });
}
fs.mkdirSync(destRoot, { recursive: true });

const EXCLUDE_RELATIVE_PATHS = new Set([
  "server/worker.js",
  "server/worker.d.ts",
  "server/worker.d.ts.map",
  "pear/pre.js",
  "pear/pre.d.ts",
  "pear/pre.d.ts.map",
]);

const EXCLUDE_SUFFIXES = [".js.map", ".d.ts.map"];

let copiedFiles = 0;
let skippedFiles = 0;

function shouldExclude(relPath) {
  if (EXCLUDE_RELATIVE_PATHS.has(relPath)) return true;
  for (const suffix of EXCLUDE_SUFFIXES) {
    if (relPath.endsWith(suffix)) return true;
  }
  return false;
}

fs.cpSync(sdkDist, destRoot, {
  recursive: true,
  filter(src) {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) return true;
    const rel = path.relative(sdkDist, src).replaceAll(path.sep, "/");
    if (shouldExclude(rel)) {
      skippedFiles++;
      return false;
    }
    copiedFiles++;
    return true;
  },
});

console.log(
  `[bundle-from-sdk] copied ${copiedFiles} files from ${path.relative(
    bareSdkRoot,
    sdkDist,
  )} to ${path.relative(bareSdkRoot, destRoot)} (skipped ${skippedFiles})`,
);

const sdkRoot = path.resolve(bareSdkRoot, "..", "sdk");
const sdkNoticePath = path.join(sdkRoot, "NOTICE");
const bareNoticePath = path.join(bareSdkRoot, "NOTICE");
if (fs.existsSync(sdkNoticePath)) {
  fs.copyFileSync(sdkNoticePath, bareNoticePath);
  console.log(`[bundle-from-sdk] auto-copied NOTICE from sibling sdk`);
} else {
  console.warn(
    `[bundle-from-sdk] sibling sdk NOTICE missing at ${sdkNoticePath}; ` +
      `bare-sdk tarball will ship without third-party attributions`,
  );
}

const sdkLicensePath = path.join(sdkRoot, "LICENSE");
const bareLicensePath = path.join(bareSdkRoot, "LICENSE");
if (fs.existsSync(sdkLicensePath) && fs.existsSync(bareLicensePath)) {
  const sdkLicense = fs.readFileSync(sdkLicensePath);
  const bareLicense = fs.readFileSync(bareLicensePath);
  if (sdkLicense.length !== bareLicense.length || !sdkLicense.equals(bareLicense)) {
    console.error(
      `[bundle-from-sdk] FAIL: packages/bare-sdk/LICENSE drifted from packages/sdk/LICENSE.\n` +
        `Fix: cp packages/sdk/LICENSE packages/bare-sdk/LICENSE`,
    );
    process.exit(1);
  }
  console.log(`[bundle-from-sdk] LICENSE in sync with sibling sdk`);
} else {
  console.warn(
    `[bundle-from-sdk] LICENSE check skipped (one or both files missing): ` +
      `sdk=${fs.existsSync(sdkLicensePath)}, bare-sdk=${fs.existsSync(bareLicensePath)}`,
  );
}
