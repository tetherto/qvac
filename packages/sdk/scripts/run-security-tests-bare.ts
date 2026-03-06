import { readdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname, relative } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const testDistRoot = join(pkgRoot, "test", "dist");
const testDistDir = join(testDistRoot, "test", "unit");

// Step 1: Compile
console.log("Compiling tests...");
spawnSync("rm", ["-rf", testDistRoot], { cwd: pkgRoot });
const compile = spawnSync(
  "tsc",
  ["--project", join(pkgRoot, "test", "tsconfig.json")],
  {
    stdio: "inherit",
    cwd: pkgRoot,
  },
);
// tsc exits non-zero for pre-existing issues in other test files (unused @ts-expect-error,
// index signature access, etc.) but emits JS via noEmitOnError: false — verify output exists
if (compile.status !== 0 && !existsSync(testDistDir)) {
  console.error("Test compilation failed — no output produced");
  process.exit(1);
}

// Step 2: Resolve @/ aliases in compiled output
function walk(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walk(full));
    else if (entry.name.endsWith(".js")) results.push(full);
  }
  return results;
}

function resolveTarget(fromFile: string, spec: string): string {
  const target = join(testDistRoot, spec);
  let rel = relative(dirname(fromFile), target).split("\\").join("/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  if (existsSync(`${target}.js`)) return `${rel}.js`;
  if (existsSync(join(target, "index.js"))) return `${rel}/index.js`;
  return `${rel}.js`;
}

for (const file of walk(testDistRoot)) {
  const content = readFileSync(file, "utf-8");
  let updated = content;
  // Static imports/exports: from "@/..."
  updated = updated.replace(
    /((?:from|import)\s*["'])@\/([^"']+)(["'])/g,
    (_m: string, pre: string, spec: string, suf: string) =>
      `${pre}${resolveTarget(file, spec)}${suf}`,
  );
  // Dynamic imports: import("@/...")
  updated = updated.replace(
    /(import\s*\(\s*["'])@\/([^"']+)(["']\s*\))/g,
    (_m: string, pre: string, spec: string, suf: string) =>
      `${pre}${resolveTarget(file, spec)}${suf}`,
  );
  if (updated !== content) writeFileSync(file, updated);
}

// Step 3: Run under Bare
if (!existsSync(testDistDir)) {
  console.error(`Test dist not found: ${testDistDir}`);
  process.exit(1);
}

const testFiles = readdirSync(testDistDir).filter(
  (f) =>
    (f.startsWith("path-traversal") || f.startsWith("path-security")) &&
    f.endsWith(".test.js"),
);

if (testFiles.length === 0) {
  console.log("No compiled security test files found.");
  process.exit(0);
}

const brittleBare = join(pkgRoot, "node_modules", ".bin", "brittle-bare");

let hasFailure = false;
for (const file of testFiles) {
  const testPath = relative(pkgRoot, join(testDistDir, file));
  console.log(`\nRunning under Bare: ${file}`);
  const result = spawnSync(brittleBare, [testPath], {
    stdio: "inherit",
    cwd: pkgRoot,
  });
  if (result.status !== 0) hasFailure = true;
}

process.exit(hasFailure ? 1 : 0);
