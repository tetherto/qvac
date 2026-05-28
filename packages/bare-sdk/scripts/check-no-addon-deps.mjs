#!/usr/bin/env node
/**
 * Assert @qvac/bare-sdk declares no plugin addon packages across any
 * dep field. Consumers install only the addons their worker registers.
 * Infrastructure @qvac/* packages are allowlisted.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.resolve(__dirname, "..", "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

const INFRA_ALLOWLIST = new Set([
  "@qvac/error",
  "@qvac/logging",
  "@qvac/decoder-audio",
  "@qvac/registry-client",
  "@qvac/langdetect-text",
  "@qvac/rag",
]);

const DEP_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];

const violations = [];

for (const field of DEP_FIELDS) {
  const deps = pkg[field] ?? {};
  for (const name of Object.keys(deps)) {
    if (!name.startsWith("@qvac/")) continue;
    if (INFRA_ALLOWLIST.has(name)) continue;
    violations.push(`${field}.${name}`);
  }
}

if (violations.length > 0) {
  console.error(
    `[check-no-addon-deps] FAIL: bare-sdk must not declare plugin addon packages. Violations:`,
  );
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    `\nIf the package is genuinely infrastructure (not a plugin addon), add it to INFRA_ALLOWLIST in this script with a justification.`,
  );
  process.exit(1);
}

console.log(
  `[check-no-addon-deps] OK: zero plugin addon packages in bare-sdk deps. ` +
    `Allowlist: ${Array.from(INFRA_ALLOWLIST).join(", ")}`,
);
