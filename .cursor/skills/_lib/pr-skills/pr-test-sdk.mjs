import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { commandCwd } from "./pr-test-generic.mjs";

export const SDK_POD_PACKAGE_PATHS = new Set([
  "packages/sdk",
  "packages/cli",
  "packages/rag",
  "packages/logging",
  "packages/error",
]);

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

export function isSdkPackage(packagePath) {
  return SDK_POD_PACKAGE_PATHS.has(packagePath);
}

export function isSdkE2eTestPath(filePath) {
  return (
    filePath.startsWith("packages/sdk/tests-qvac/tests/") &&
    filePath.endsWith(".ts")
  );
}

export function isSdkRunnableExamplePath(filePath) {
  const name = basename(filePath);
  if (name === "shared.ts" || name === "shared.js") return false;
  if (name === "utils.ts" || name === "utils.js") return false;
  return filePath.endsWith(".ts") || filePath.endsWith(".js");
}

export function sdkExampleCommand(packagePath, filePath) {
  const localPath = filePath.slice(`${packagePath}/`.length);
  return {
    cwd: packagePath,
    command: `bun run ${localPath}`,
    reason: "Changed SDK example",
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

export function exampleTraits(absPath) {
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

function changedExampleGroups(packagePath, changedExamples) {
  return new Set(
    changedExamples
      .map((path) => path.slice(`${packagePath}/examples/`.length).split("/")[0])
      .filter(Boolean),
  );
}

export function relatedSdkExamples({
  root,
  packagePath,
  changedPaths,
  changedExamples,
  worktreePath,
}) {
  const examplesRoot = join(root, packagePath, "examples");
  const topics = topicTokens(changedPaths);
  const changed = new Set(changedExamples);
  const exampleGroups = changedExampleGroups(packagePath, changedExamples);
  const candidates = walkFiles(examplesRoot)
    .map((rel) => `${packagePath}/examples/${rel}`)
    .filter(isSdkRunnableExamplePath)
    .filter((path) => !changed.has(path))
    .filter((path) => {
      if (exampleGroups.size === 0) return true;
      const group = path.slice(`${packagePath}/examples/`.length).split("/")[0];
      return exampleGroups.has(group);
    })
    .map((path) => {
      const score = scoreRelatedPath(path, topics);
      const traits = exampleTraits(join(root, path));
      const example = sdkExampleCommand(packagePath, path);
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

export function relatedSdkTests({
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

export function sdkE2eSetup(touchedPaths) {
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

export function recommendSdkPackage() {
  return {
    recommendedTier: "T2",
    recommendationReason:
      "SDK default: install/build + changed examples if present + changed e2e on desktop; mobile is opt-in because CI covers it",
  };
}
