#!/usr/bin/env node
/**
 * Assert plugin addon packages are imported only from their own plugin
 * manifests under dist/_sdk/server/bare/plugins/<plugin>/. A leak
 * elsewhere would force the addon into every consumer bundle.
 * Run after bundle-from-sdk.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_ADDONS } from "./plugin-addons.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bareSdkRoot = path.resolve(__dirname, "..");
const distRoot = path.resolve(bareSdkRoot, "dist", "_sdk");

if (!fs.existsSync(distRoot)) {
  console.error(
    `[check-no-addon-leaks] ${distRoot} does not exist. Run \`bun run bundle\` first.`,
  );
  process.exit(1);
}

// Plugin manifest paths where addon imports are legitimately expected.
// Format: dist/_sdk/server/bare/plugins/<plugin-name>/...
const PLUGIN_MANIFEST_PREFIX = "server/bare/plugins/";

const IMPORT_REGEX =
  /(?:import\s+[^"']+from|export\s+[^"']+from|import\s*\()\s*["']([^"']+)["']/g;

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else if (entry.name.endsWith(".js")) acc.push(p);
  }
  return acc;
}

const files = walk(distRoot);
const violations = [];

for (const file of files) {
  const rel = path.relative(distRoot, file).replaceAll(path.sep, "/");
  const src = fs.readFileSync(file, "utf8");
  IMPORT_REGEX.lastIndex = 0;
  let m;
  while ((m = IMPORT_REGEX.exec(src)) !== null) {
    const spec = m[1];
    const pkg = spec.startsWith("@")
      ? spec.split("/").slice(0, 2).join("/")
      : spec.split("/")[0];
    if (!PLUGIN_ADDONS.has(pkg)) continue;

    if (rel.startsWith(PLUGIN_MANIFEST_PREFIX)) {
      const segments = rel.slice(PLUGIN_MANIFEST_PREFIX.length).split("/");
      const pluginDir = segments[0];
      if (pluginDir && pluginDir.length > 0) continue;
    }

    violations.push({ file: rel, spec });
  }
}

if (violations.length > 0) {
  console.error(
    `[check-no-addon-leaks] FAIL: plugin addon imports detected outside server/bare/plugins/<plugin>/**:`,
  );
  for (const v of violations) {
    console.error(`  ${v.file} -> ${v.spec}`);
  }
  console.error(
    `\nPlugin addon imports must be confined to plugin manifest files so consumers who don't register a given plugin never pull in its addon.`,
  );
  process.exit(1);
}

console.log(
  `[check-no-addon-leaks] OK: ${files.length} files scanned, all plugin addon imports confined to plugin manifest paths.`,
);
