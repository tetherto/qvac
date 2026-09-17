import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outputs = ["index.js", "index.d.ts", "mobile.js", "mobile.d.ts"];
const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "ggml-rpc-server-generated-"),
);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

try {
  let status = run(npmCommand, [
    "run",
    "build:ts",
    "--",
    "--outDir",
    temporaryRoot,
  ]);
  if (status === 0) {
    status = run(npxCommand, [
      "--no-install",
      "prettier",
      "--write",
      path.join(temporaryRoot, "*.js"),
    ]);
  }

  if (status !== 0) {
    process.exitCode = status;
  } else {
    const changed = outputs.filter((output) => {
      const committed = path.join(packageRoot, output);
      const generated = path.join(temporaryRoot, output);
      return (
        !fs.existsSync(committed) ||
        !fs.existsSync(generated) ||
        !fs.readFileSync(committed).equals(fs.readFileSync(generated))
      );
    });

    if (changed.length > 0) {
      console.error(`Generated files are out of date:\n${changed.join("\n")}`);
      process.exitCode = 1;
    } else {
      console.log("Generated files are up to date.");
    }
  }
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
