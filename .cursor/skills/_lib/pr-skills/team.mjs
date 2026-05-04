// Team metadata loader for the pr-skills shared library.
//
// Loads .github/teams/<pod>.json from the repository root. The repo root is
// resolved by walking up from this file's location until a directory
// containing .git/ is found.

import { existsSync, readFileSync } from "node:fs";
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

function assertStringArray(value, fieldName, file) {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new Error(`${file}: ${fieldName} must be an array of strings`);
  }
}

export function loadTeam(pod) {
  if (!pod || typeof pod !== "string") {
    throw new Error("loadTeam(pod): pod must be a non-empty string");
  }
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const root = findRepoRoot(scriptDir);
  const teamFile = join(root, ".github", "teams", `${pod}.json`);
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
    name: typeof parsed.name === "string" ? parsed.name : pod,
    leads: parsed.leads,
    members: parsed.members,
    ownedPaths: parsed.ownedPaths,
    repoRoot: root,
    teamFile,
  };
}
