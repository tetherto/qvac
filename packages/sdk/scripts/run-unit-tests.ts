import { readdirSync } from "fs";
import { join, dirname } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const testDir = join(__dirname, "..", "test", "unit");

function collectTestFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

const testFiles = collectTestFiles(testDir);

let hasFailure = false;

for (const file of testFiles) {
  const result = spawnSync("bun", ["run", file], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    hasFailure = true;
  }
}

process.exit(hasFailure ? 1 : 0);
