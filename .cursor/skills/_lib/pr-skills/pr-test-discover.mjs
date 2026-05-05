#!/usr/bin/env node
//
// Discovery helper for /pr-test.
//
// Usage:
//   node pr-test-discover.mjs <PR-URL> --worktree <WORKTREE_PATH> \
//     --head-sha <HEAD_SHA> --patch <PATCH_PATH>
//
// The file list and per-file status come from committed PR state only:
// `/tmp/pr-<num>.json` (`gh pr view --json files`) plus the patch emitted by
// worktree-prepare.mjs. This helper never uses git diff/status against the
// worktree, which may contain untracked build artifacts from /pr-test.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePRUrl } from "./worktree.mjs";

const PR_JSON_FIELDS = [
  "number",
  "title",
  "baseRefName",
  "headRefName",
  "headRefOid",
  "files",
].join(",");

const SDK_POD_PACKAGE_PATHS = new Set([
  "packages/sdk",
  "packages/cli",
  "packages/rag",
  "packages/logging",
  "packages/error",
]);

const TEST_STATUS = new Set(["A", "M", "R"]);

const TOKEN_STOP_WORDS = new Set([
  "packages",
  "package",
  "src",
  "lib",
  "server",
  "client",
  "tests",
  "test",
  "shared",
  "executor",
  "executors",
  "index",
  "types",
  "utils",
]);

const TOPIC_ALIASES = new Map([
  ["whisper", "transcription"],
  ["parakeet", "transcription"],
  ["transcribe", "transcription"],
  ["transcription", "transcription"],
  ["tool", "tools"],
  ["tools", "tools"],
  ["harmony", "tools"],
  ["function", "tools"],
  ["completion", "completion"],
  ["translate", "translation"],
  ["translation", "translation"],
  ["bergamot", "bergamot"],
  ["embedding", "embedding"],
  ["embed", "embedding"],
  ["diffusion", "diffusion"],
  ["tts", "tts"],
  ["ocr", "ocr"],
  ["rag", "rag"],
  ["cache", "cache"],
  ["config", "config"],
  ["registry", "registry"],
  ["download", "download"],
  ["logging", "logging"],
  ["finetune", "finetune"],
]);

function usage() {
  throw new Error(
    "usage: pr-test-discover.mjs <PR-URL> --worktree <path> " +
      "--head-sha <sha> --patch <path>",
  );
}

function readArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  }).trim();
}

function findRepoRoot(startDir) {
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

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function ensurePRJson({ owner, repo, num }) {
  const path = `/tmp/pr-${num}.json`;
  if (existsSync(path)) {
    return { path, pr: readJsonFile(path), fetched: false };
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

function ensurePatch({ owner, repo, num, patchPath }) {
  const path = patchPath || `/tmp/pr-${num}.patch`;
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

function parsePatchStatuses(patchText) {
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

function packagePathFor(filePath) {
  const parts = filePath.split("/");
  if (parts[0] !== "packages" || !parts[1]) return null;
  return `packages/${parts[1]}`;
}

function readPackageJson(root, packagePath) {
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

function discoverCommands(packagePath, packageJson) {
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

function classifyPackage(packagePath, packageJson) {
  if (packagePath === "packages/sdk") return "sdk-pod";
  if (
    packageJson.addon === true ||
    packagePath.startsWith("packages/qvac-lib-infer-")
  ) {
    return "addon";
  }
  if (SDK_POD_PACKAGE_PATHS.has(packagePath)) return "sdk-pod";
  return "other";
}

function isExamplePath(packagePath, filePath) {
  return filePath.startsWith(`${packagePath}/examples/`);
}

function isRunnableExamplePath(filePath) {
  const name = basename(filePath);
  if (name === "shared.ts" || name === "shared.js") return false;
  if (name === "utils.ts" || name === "utils.js") return false;
  return filePath.endsWith(".ts") || filePath.endsWith(".js");
}

function isSdkE2eTestPath(filePath) {
  return (
    filePath.startsWith("packages/sdk/tests-qvac/tests/") &&
    filePath.endsWith(".ts")
  );
}

function isGenericTestPath(packagePath, filePath) {
  return (
    filePath.startsWith(`${packagePath}/test/`) ||
    filePath.startsWith(`${packagePath}/tests/`)
  );
}

function exampleCommand(packagePath, filePath) {
  const localPath = filePath.slice(`${packagePath}/`.length);
  if (packagePath === "packages/sdk") {
    return {
      cwd: packagePath,
      command: `bun run ${localPath}`,
      reason: "Changed SDK example",
    };
  }
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

function walkFiles(root, prefix = "") {
  if (!existsSync(root)) return [];
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === "build"
    ) {
      continue;
    }
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(abs, rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function tokenize(value) {
  return String(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(
      (token) => token && token.length > 1 && !TOKEN_STOP_WORDS.has(token),
    )
    .map((token) => TOPIC_ALIASES.get(token) || token);
}

function topicTokens(changedPaths) {
  const tokens = new Set();
  for (const path of changedPaths) {
    for (const token of tokenize(path)) {
      tokens.add(token);
    }
  }
  return tokens;
}

function scoreRelatedPath(path, topics) {
  const tokens = new Set(tokenize(path));
  let score = 0;
  for (const token of topics) {
    if (tokens.has(token)) score += 2;
  }
  return score;
}

function exampleTraits(absPath) {
  let text = "";
  try {
    text = readFileSync(absPath, "utf-8");
  } catch {
    // Unknown content should not block discovery; mark it as lower confidence.
  }
  const requiresInput =
    /\bprocess\.argv\b|\breadline\b|\bprompt\b|\bstdin\b|\bmic(rophone)?\b/i.test(
      text,
    );
  const outputPattern = new RegExp(
    [
      "\\bwriteFile(Sync)?\\b",
      "\\bcreateWriteStream\\b",
      "\\bappendFile(Sync)?\\b",
      "\\boutput(_\\d+)?\\.(png|jpg|jpeg|wav|json|txt)\\b",
      "\\bsave[A-Z]?\\w*\\(",
    ].join("|"),
    "i",
  );
  const writesOutput = outputPattern.test(text);
  const notes = [];
  if (requiresInput) notes.push("may require input/device");
  if (writesOutput) notes.push("may write output files");
  return {
    safeToRun: !requiresInput && !writesOutput,
    requiresInput,
    writesOutput,
    notes,
  };
}

function relatedSdkExamples({
  root,
  packagePath,
  changedPaths,
  changedExamples,
  worktreePath,
}) {
  const examplesRoot = join(root, packagePath, "examples");
  const topics = topicTokens(changedPaths);
  const changed = new Set(changedExamples);
  const changedExampleGroups = new Set(
    changedExamples
      .map((path) => path.slice(`${packagePath}/examples/`.length).split("/")[0])
      .filter(Boolean),
  );
  const candidates = walkFiles(examplesRoot)
    .map((rel) => `${packagePath}/examples/${rel}`)
    .filter(isRunnableExamplePath)
    .filter((path) => !changed.has(path))
    .filter((path) => {
      if (changedExampleGroups.size === 0) return true;
      const group = path.slice(`${packagePath}/examples/`.length).split("/")[0];
      return changedExampleGroups.has(group);
    })
    .map((path) => {
      const score = scoreRelatedPath(path, topics);
      const traits = exampleTraits(join(root, path));
      const example = exampleCommand(packagePath, path);
      return {
        path,
        ...example,
        cwd: commandCwd(worktreePath, example.cwd),
        reason: `Related SDK example (score ${score})`,
        score,
        ...traits,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        Number(b.safeToRun) - Number(a.safeToRun) ||
        b.score - a.score ||
        a.path.localeCompare(b.path),
    );
  return candidates.slice(0, 5);
}

function changedExampleGroups(packagePath, changedExamples) {
  return new Set(
    changedExamples
      .map((path) => path.slice(`${packagePath}/examples/`.length).split("/")[0])
      .filter(Boolean),
  );
}

function relatedSdkTests({
  root,
  packagePath,
  changedPaths,
  changedTests,
  changedExamples,
}) {
  const testsRoot = join(root, packagePath, "tests-qvac", "tests");
  const topics = topicTokens(changedPaths);
  const changed = new Set(changedTests);
  const exampleGroups = changedExampleGroups(packagePath, changedExamples);
  const candidates = walkFiles(testsRoot)
    .filter((rel) => rel.endsWith("-tests.ts"))
    .map((rel) => `${packagePath}/tests-qvac/tests/${rel}`)
    .filter((path) => !changed.has(path))
    .map((path) => {
      const filter = basename(path).replace(/-tests\.ts$/, "");
      let score = scoreRelatedPath(path, topics);
      for (const group of exampleGroups) {
        if (filter === group || filter.includes(group)) score += 10;
      }
      return {
        path,
        filter,
        reason: `Related SDK e2e filter (score ${score})`,
        score,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) => b.score - a.score || a.path.localeCompare(b.path),
    );
  return candidates.slice(0, 5);
}

function sdkE2eSetup(touchedPaths) {
  const touchesSdkOutsideTestsQvac = touchedPaths.some(
    (path) =>
      path.startsWith("packages/sdk/") &&
      !path.startsWith("packages/sdk/tests-qvac/"),
  );
  if (touchesSdkOutsideTestsQvac) {
    return {
      command: "npm run install:build:full",
      reason: "Committed PR files touch packages/sdk outside tests-qvac",
    };
  }
  return {
    command: "npm run install:build",
    reason: "Committed SDK e2e changes are limited to packages/sdk/tests-qvac",
  };
}

function recommendPackage({ packagePath, commands }) {
  if (packagePath === "packages/sdk") {
    return {
      recommendedTier: "T2",
      recommendationReason:
        "SDK default: install/build + changed examples if present + changed e2e on desktop; mobile is opt-in because CI covers it",
    };
  }
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

function tierRank(tier) {
  if (tier === "build-only") return 0;
  const m = String(tier).match(/^T(\d+)$/);
  return m ? Number.parseInt(m[1], 10) : 0;
}

function commandCwd(worktreePath, packagePath) {
  if (!worktreePath) return packagePath;
  return join(worktreePath, packagePath);
}

function buildManifest({
  pr,
  statuses,
  root,
  worktreePath,
  headSha,
  patchPath,
  prJsonPath,
  patchFetched,
  prJsonFetched,
}) {
  const fileStatuses = [...statuses.values()];
  const files = (pr.files || []).map((f) => ({ path: f.path }));
  const packagePaths = [
    ...new Set(files.map((f) => packagePathFor(f.path)).filter(Boolean)),
  ].sort();
  const touchedPackages = [];

  for (const packagePath of packagePaths) {
    const packageJson = readPackageJson(worktreePath || root, packagePath);
    if (!packageJson) continue;

    const packageFiles = fileStatuses.filter((f) =>
      f.path.startsWith(`${packagePath}/`),
    );
    const changedPaths = packageFiles
      .filter((f) => TEST_STATUS.has(f.status))
      .map((f) => f.path)
      .sort();
    const addedOrModifiedExamples = changedPaths
      .filter((path) => isExamplePath(packagePath, path))
      .sort();
    const exampleCommands = addedOrModifiedExamples
      .filter(isRunnableExamplePath)
      .map((path) => {
        const example = exampleCommand(packagePath, path);
        const traits = exampleTraits(join(worktreePath || root, path));
        return {
          path,
          ...example,
          cwd: commandCwd(worktreePath, example.cwd),
          ...traits,
        };
      });

    let addedOrModifiedTests = [];
    if (packagePath === "packages/sdk") {
      addedOrModifiedTests = changedPaths.filter(isSdkE2eTestPath).sort();
    } else {
      addedOrModifiedTests = changedPaths
        .filter((path) => isGenericTestPath(packagePath, path))
        .sort();
    }

    const commands = discoverCommands(packagePath, packageJson);
    const kind = classifyPackage(packagePath, packageJson);
    const recommendation = recommendPackage({ packagePath, commands });
    const relatedExampleCommands =
      packagePath === "packages/sdk"
        ? relatedSdkExamples({
            root: worktreePath || root,
            packagePath,
            changedPaths,
            changedExamples: addedOrModifiedExamples,
            worktreePath,
          })
        : [];
    const relatedTests =
      packagePath === "packages/sdk"
        ? relatedSdkTests({
            root: worktreePath || root,
            packagePath,
            changedPaths,
            changedTests: addedOrModifiedTests,
            changedExamples: addedOrModifiedExamples,
          })
        : [];
    const packageInfo = {
      path: packagePath,
      cwd: commandCwd(worktreePath, packagePath),
      name: packageJson.name || null,
      kind,
      recommendedTier: recommendation.recommendedTier,
      recommendationReason: recommendation.recommendationReason,
      scripts: packageJson.scripts || {},
      commands,
      addedOrModifiedExamples,
      exampleCommands,
      relatedExampleCommands,
      addedOrModifiedTests,
      relatedTests,
      hasExamples: addedOrModifiedExamples.length > 0,
      hasRelatedExamples: relatedExampleCommands.length > 0,
      hasTests:
        addedOrModifiedTests.length > 0 ||
        relatedTests.length > 0 ||
        commands.testCandidates.length > 0,
    };

    if (packagePath === "packages/sdk") {
      packageInfo.sdkE2eSetup = sdkE2eSetup(changedPaths);
      packageInfo.sdkTestsQvacCwd = worktreePath
        ? join(worktreePath, "packages", "sdk", "tests-qvac")
        : "packages/sdk/tests-qvac";
    }

    touchedPackages.push(packageInfo);
  }

  const overall = touchedPackages.reduce(
    (best, pkg) =>
      tierRank(pkg.recommendedTier) > tierRank(best.recommendedTier)
        ? {
            recommendedTier: pkg.recommendedTier,
            recommendationReason: pkg.recommendationReason,
          }
        : best,
    {
      recommendedTier: "build-only",
      recommendationReason:
        "No package-level unit/e2e scripts were discovered; install/build only",
    },
  );

  return {
    pr: {
      number: pr.number,
      title: pr.title,
      baseRefName: pr.baseRefName,
      headRefName: pr.headRefName,
      headRefOid: pr.headRefOid,
    },
    headSha: headSha || pr.headRefOid || null,
    headSha7: (headSha || pr.headRefOid || "").slice(0, 7),
    worktreePath,
    patchPath,
    prJsonPath,
    dataSources: {
      prJsonFetched,
      patchFetched,
      diffSource: "committed-pr-patch",
      localWorktreeDiffUsed: false,
    },
    recommendation: overall,
    touchedPackages,
  };
}

const url = process.argv[2];
if (!url || url.startsWith("--")) usage();

const parsed = parsePRUrl(url);
const worktreePath = readArg("--worktree") || null;
const headSha = readArg("--head-sha") || null;
const patchArg = readArg("--patch") || null;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(scriptDir);
const { path: prJsonPath, pr, fetched: prJsonFetched } = ensurePRJson(parsed);
const { path: patchPath, fetched: patchFetched } = ensurePatch({
  ...parsed,
  patchPath: patchArg,
});

const patchText = readFileSync(patchPath, "utf-8");
const statuses = parsePatchStatuses(patchText);
const manifest = buildManifest({
  pr,
  statuses,
  root: repoRoot,
  worktreePath,
  headSha,
  patchPath,
  prJsonPath,
  patchFetched,
  prJsonFetched,
});

if (worktreePath) {
  manifest.worktreeRelativeToRepo = relative(repoRoot, worktreePath);
}

process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
