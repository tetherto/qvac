// Team metadata loader for the pr-skills shared library.
//
// Loads .github/teams/<pod>.json from the repository root. The repo root is
// resolved by walking up from this file's location until a directory
// containing .git/ is found.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

function teamsDir() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const root = findRepoRoot(scriptDir);
  return join(root, ".github", "teams");
}

function assertStringArray(value, fieldName, file) {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new Error(`${file}: ${fieldName} must be an array of strings`);
  }
}

export function loadTeam(pod) {
  if (!pod || typeof pod !== "string") {
    throw new Error("loadTeam(pod): pod must be a non-empty string");
  }
  const dir = teamsDir();
  const teamFile = join(dir, `${pod}.json`);
  if (!existsSync(teamFile)) {
    throw new Error(
      `Team file not found: ${teamFile}\n` +
        `Create it with { name, leads, members, ownedPaths } to onboard a new pod.`,
    );
  }
  const parsed = JSON.parse(readFileSync(teamFile, "utf-8"));
  assertStringArray(parsed.leads, "leads", teamFile);
  assertStringArray(parsed.members, "members", teamFile);
  assertStringArray(parsed.ownedPaths, "ownedPaths", teamFile);
  if (parsed.leads.length === 0 && parsed.members.length === 0) {
    console.error(`Warning: ${teamFile} has no leads or members`);
  }
  return {
    pod,
    name: typeof parsed.name === "string" ? parsed.name : pod,
    leads: parsed.leads,
    members: parsed.members,
    ownedPaths: parsed.ownedPaths,
    teamFile,
  };
}

// Discover every pod registered under .github/teams/. Used by cross-pod
// modes (e.g. /pr-mine) where the user's PRs may span multiple pods.
// Returns an array of team objects (same shape as loadTeam(pod)).
export function discoverPods() {
  const dir = teamsDir();
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const pods = [];
  for (const f of files) {
    const podName = f.replace(/\.json$/, "");
    try {
      pods.push(loadTeam(podName));
    } catch (e) {
      console.error(`Skipping malformed ${f}: ${e.message}`);
    }
  }
  return pods;
}

// Find the pod that owns a PR based on its touched files. Returns the
// first pod whose ownedPaths overlap with the PR's files, or null. Order
// is the readdir order of .github/teams/ — for a PR that touches paths
// in multiple pods, the first match wins.
export function findPodForFiles(files, pods) {
  if (!files || !pods) return null;
  for (const pod of pods) {
    if (files.some((f) => pod.ownedPaths.some((p) => f.path.startsWith(p)))) {
      return pod;
    }
  }
  return null;
}
