import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const TEST_STATUS = new Set(["A", "M", "R"]);

export const PR_JSON_FIELDS = [
  "number",
  "title",
  "baseRefName",
  "headRefName",
  "headRefOid",
  "files",
].join(",");

export function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  }).trim();
}

export function findRepoRoot(startDir) {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not find repo root from ${startDir} (no .git/ in any parent)`,
      );
    }
    dir = parent;
  }
}

export function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function ensurePRJson({ owner, repo, num }) {
  const path = join(tmpdir(), `pr-${num}.json`);
  if (existsSync(path)) {
    const pr = readJsonFile(path);
    if (Array.isArray(pr.files)) {
      return { path, pr, fetched: false };
    }
  }
  const raw = gh([
    "pr",
    "view",
    String(num),
    "--repo",
    `${owner}/${repo}`,
    "--json",
    PR_JSON_FIELDS,
  ]);
  writeFileSync(path, `${raw}\n`);
  return { path, pr: JSON.parse(raw), fetched: true };
}

export function ensurePatch({ owner, repo, num, patchPath }) {
  const path = patchPath || join(tmpdir(), `pr-${num}.patch`);
  if (existsSync(path)) {
    return { path, fetched: false };
  }
  const raw = gh([
    "pr",
    "diff",
    String(num),
    "--repo",
    `${owner}/${repo}`,
    "--patch",
  ]);
  writeFileSync(path, raw.endsWith("\n") ? raw : `${raw}\n`);
  return { path, fetched: true };
}

function unquotePatchPath(path) {
  if (!path) return path;
  if (path.startsWith('"') && path.endsWith('"')) {
    try {
      return JSON.parse(path);
    } catch {
      return path.slice(1, -1);
    }
  }
  return path;
}

function parseDiffGitPath(raw) {
  const path = unquotePatchPath(raw);
  if (path === "/dev/null") return null;
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

export function parsePatchStatuses(patchText) {
  const statuses = new Map();
  let current = null;

  function finish() {
    if (!current) return;
    const path = current.newPath || current.oldPath;
    if (!path) {
      current = null;
      return;
    }
    statuses.set(path, {
      path,
      oldPath: current.oldPath,
      status: current.status,
    });
    current = null;
  }

  for (const line of patchText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      finish();
      const m = line.match(/^diff --git (.+) (.+)$/);
      if (!m) continue;
      current = {
        oldPath: parseDiffGitPath(m[1]),
        newPath: parseDiffGitPath(m[2]),
        status: "M",
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode ")) {
      current.status = "A";
    } else if (line.startsWith("deleted file mode ")) {
      current.status = "D";
    } else if (line.startsWith("rename from ")) {
      current.oldPath = unquotePatchPath(line.slice("rename from ".length));
      current.status = "R";
    } else if (line.startsWith("rename to ")) {
      current.newPath = unquotePatchPath(line.slice("rename to ".length));
      current.status = "R";
    } else if (line.startsWith("+++ ")) {
      const parsed = parseDiffGitPath(line.slice("+++ ".length));
      if (parsed) current.newPath = parsed;
    } else if (line.startsWith("--- ")) {
      const parsed = parseDiffGitPath(line.slice("--- ".length));
      if (parsed) current.oldPath = parsed;
    }
  }
  finish();
  return statuses;
}

export function packagePathFor(filePath) {
  const parts = filePath.split("/");
  if (parts[0] !== "packages" || !parts[1]) return null;
  return `packages/${parts[1]}`;
}

export function readPackageJson(root, packagePath) {
  const path = join(root, packagePath, "package.json");
  if (!existsSync(path)) return null;
  return readJsonFile(path);
}

function packageManager(packagePath, packageJson) {
  if (packagePath === "packages/sdk") return "bun";
  if (typeof packageJson.packageManager === "string") {
    if (packageJson.packageManager.startsWith("bun")) return "bun";
    if (packageJson.packageManager.startsWith("npm")) return "npm";
  }
  const scripts = packageJson.scripts || {};
  if (
    typeof scripts.build === "string" &&
    /\bbun\s+run\b/.test(scripts.build)
  ) {
    return "bun";
  }
  return "npm";
}

function commandForScript(manager, script) {
  if (manager === "bun") return `bun run ${script}`;
  return `npm run ${script}`;
}

export function discoverCommands(packagePath, packageJson) {
  const manager = packageManager(packagePath, packageJson);
  const scripts = packageJson.scripts || {};
  const commands = {
    install: manager === "bun" ? "bun install" : "npm install",
    build: null,
    unit: null,
    testCandidates: [],
    full: null,
  };

  if (scripts.build) commands.build = commandForScript(manager, "build");
  if (scripts["test:unit"]) {
    commands.unit = commandForScript(manager, "test:unit");
  } else if (scripts.test) {
    commands.unit = commandForScript(manager, "test");
  }
  if (scripts["test:all"]) commands.full = commandForScript(manager, "test:all");

  const testNames = Object.keys(scripts)
    .filter((name) => name === "test" || name.startsWith("test:"))
    .sort((a, b) => scoreTestScript(a) - scoreTestScript(b) || a.localeCompare(b));

  commands.testCandidates = testNames.map((name) => ({
    name,
    command: commandForScript(manager, name),
    score: scoreTestScript(name),
  }));

  if (packageJson.addon === true && scripts.build) {
    commands.build = commandForScript(manager, "build");
  }

  return commands;
}

function scoreTestScript(name) {
  if (name === "test:unit") return 10;
  if (name === "test") return 20;
  if (name === "test:integration") return 30;
  if (name.includes("mobile")) return 40;
  if (name === "test:all") return 90;
  return 50;
}

export function classifyGenericPackage(packagePath, packageJson) {
  if (
    packageJson.addon === true ||
    packagePath.startsWith("packages/qvac-lib-infer-")
  ) {
    return "addon";
  }
  return "other";
}

export function isGenericTestPath(packagePath, filePath) {
  return (
    filePath.startsWith(`${packagePath}/test/`) ||
    filePath.startsWith(`${packagePath}/tests/`)
  );
}

export function genericExampleCommand(packagePath, filePath) {
  const localPath = filePath.slice(`${packagePath}/`.length);
  if (filePath.endsWith(".js")) {
    return {
      cwd: packagePath,
      command: `bare ${localPath}`,
      reason: "Changed Bare/Node example",
    };
  }
  return {
    cwd: packagePath,
    command: `node ${localPath}`,
    reason: "Changed example",
  };
}

export function recommendGenericPackage({ commands }) {
  if (commands.unit) {
    return {
      recommendedTier: "T2",
      recommendationReason:
        "Non-SDK default: at least unit-level validation via package.json scripts",
    };
  }
  if (commands.testCandidates.length > 0) {
    return {
      recommendedTier: "T2",
      recommendationReason:
        "Non-SDK default: first available package.json test script in the least-to-most-complete ladder",
    };
  }
  return {
    recommendedTier: "build-only",
    recommendationReason:
      "No unit/e2e scripts were discovered; recommend install/build validation only",
  };
}

export function tierRank(tier) {
  if (tier === "build-only") return 0;
  const m = String(tier).match(/^T(\d+)$/);
  return m ? Number.parseInt(m[1], 10) : 0;
}

export function commandCwd(worktreePath, packagePath) {
  if (!worktreePath) return packagePath;
  return join(worktreePath, packagePath);
}
