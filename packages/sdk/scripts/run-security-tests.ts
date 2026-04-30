import { readdirSync } from "fs";
import { join, dirname } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const testDir = join(__dirname, "..", "test", "unit");
const testFiles = readdirSync(testDir).filter(
  (f) =>
    (f.startsWith("path-traversal") || f.startsWith("path-security")) &&
    f.endsWith(".test.ts"),
);

if (testFiles.length === 0) {
  console.log("No security tests found.");
  process.exit(0);
}

let hasFailure = false;

for (const file of testFiles) {
  const result = spawnSync("bun", ["run", join(testDir, file)], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    hasFailure = true;
  }
}

process.exit(hasFailure ? 1 : 0);
