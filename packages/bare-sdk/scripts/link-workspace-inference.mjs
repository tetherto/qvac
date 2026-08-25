// Overrides bare-sdk's @qvac/inference dependency with the in-monorepo sibling
// for the "workspace" pod-check leg, so bare-sdk builds and tests against the
// engine at the same commit.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inferenceDir = path.resolve(pkgDir, "..", "inference");

function declaresInference() {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"),
  );
  return Boolean(pkg.dependencies?.["@qvac/inference"]);
}

function run(command, args, cwd) {
  const { status, error } = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (error) throw error;
  if (status !== 0) process.exit(status ?? 1);
}

if (!declaresInference()) {
  console.log(
    "[link-workspace-inference] @qvac/inference is not a dependency; skipping",
  );
  process.exit(0);
}

run("bun", ["install"], inferenceDir);
run("bun", ["run", "build"], inferenceDir);

const manifestPath = path.join(pkgDir, "package.json");
const pkg = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
pkg.dependencies["@qvac/inference"] = "file:../inference";
fs.writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`);
run("bun", ["install"], pkgDir);
