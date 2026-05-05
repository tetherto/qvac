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

import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TEST_STATUS,
  classifyGenericPackage,
  commandCwd,
  discoverCommands,
  ensurePRJson,
  ensurePatch,
  findRepoRoot,
  genericExampleCommand,
  isGenericTestPath,
  packagePathFor,
  parsePatchStatuses,
  readPackageJson,
  recommendGenericPackage,
  tierRank,
} from "./pr-test-generic.mjs";
import {
  exampleTraits,
  isSdkE2eTestPath,
  isSdkPackage,
  isSdkRunnableExamplePath,
  recommendSdkPackage,
  relatedSdkExamples,
  relatedSdkTests,
  sdkE2eSetup,
  sdkExampleCommand,
} from "./pr-test-sdk.mjs";
import { parsePRUrl } from "./worktree.mjs";

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

function isExamplePath(packagePath, filePath) {
  return filePath.startsWith(`${packagePath}/examples/`);
}

function isRunnableExamplePath(packagePath, filePath) {
  if (isSdkPackage(packagePath)) return isSdkRunnableExamplePath(filePath);
  return filePath.endsWith(".ts") || filePath.endsWith(".js");
}

function exampleCommand(packagePath, filePath) {
  if (isSdkPackage(packagePath)) return sdkExampleCommand(packagePath, filePath);
  return genericExampleCommand(packagePath, filePath);
}

function classifyPackage(packagePath, packageJson) {
  if (isSdkPackage(packagePath)) return "sdk-pod";
  return classifyGenericPackage(packagePath, packageJson);
}

function recommendPackage({ packagePath, commands }) {
  if (isSdkPackage(packagePath)) return recommendSdkPackage();
  return recommendGenericPackage({ commands });
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
      .filter((path) => isRunnableExamplePath(packagePath, path))
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
    if (isSdkPackage(packagePath)) {
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
      isSdkPackage(packagePath)
        ? relatedSdkExamples({
            root: worktreePath || root,
            packagePath,
            changedPaths,
            changedExamples: addedOrModifiedExamples,
            worktreePath,
          })
        : [];
    const relatedTests =
      isSdkPackage(packagePath)
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

    if (isSdkPackage(packagePath)) {
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
