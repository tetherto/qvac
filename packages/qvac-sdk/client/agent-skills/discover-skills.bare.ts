import fs from "bare-fs";
import path from "bare-path";
import process from "bare-process";
import {
  PROJECT_SKILL_DIRECTORY_DEFINITIONS,
  USER_SKILL_DIRECTORY_DEFINITIONS,
  dedupeSkillsByName,
  toAgentSkill,
} from "@/client/agent-skills/common";
import { getClientLogger } from "@/logging";
import type {
  AgentSkill,
  AgentSkillScope,
  AgentSkillSourceKind,
} from "@/schemas/agent-skills";

const logger = getClientLogger();

function pathExists(filePath: string) {
  return fs.existsSync(filePath);
}

function directoryExists(dirPath: string) {
  try {
    const stats = fs.statSync(dirPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

function findGitRoot(startDir: string) {
  let currentDir = path.resolve(startDir);
  const root = path.parse(currentDir).root;

  while (true) {
    const gitPath = path.join(currentDir, ".git");
    if (pathExists(gitPath)) {
      return currentDir;
    }
    if (currentDir === root) {
      return undefined;
    }
    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      return undefined;
    }
    currentDir = parent;
  }
}

function getLocalSearchRoots(startDir: string) {
  const gitRoot = findGitRoot(startDir);
  const roots: string[] = [];
  const stopAt = gitRoot ?? path.resolve(startDir);
  let currentDir = path.resolve(startDir);

  while (true) {
    roots.push(currentDir);
    if (currentDir === stopAt) {
      break;
    }
    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      break;
    }
    currentDir = parent;
  }

  return roots;
}

function readFileUtf8(filePath: string) {
  const content = fs.readFileSync(filePath, "utf-8");
  if (typeof content === "string") {
    return content;
  }
  return content.toString("utf-8");
}

function discoverSkillsInDirectory(
  skillsDirPath: string,
  sourceKind: AgentSkillSourceKind,
  scope: AgentSkillScope,
) {
  if (!directoryExists(skillsDirPath)) return [];

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(skillsDirPath) as string[];
  } catch {
    return [];
  }

  const sortedEntries = entries.slice().sort((a, b) => a.localeCompare(b));
  const discovered: AgentSkill[] = [];

  for (const entryName of sortedEntries) {
    const entryPath = path.join(skillsDirPath, entryName);
    if (!directoryExists(entryPath)) {
      continue;
    }

    const skillFilePath = path.join(entryPath, "SKILL.md");
    if (!pathExists(skillFilePath)) {
      continue;
    }

    try {
      const raw = readFileUtf8(skillFilePath);
      const skill = toAgentSkill({
        content: raw,
        sourcePath: skillFilePath,
        sourceKind,
        scope,
        fallbackName: entryName,
      });
      if (skill) {
        discovered.push(skill);
      }
    } catch (error) {
      logger.warn(
        `Failed to read skill file at ${skillFilePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return discovered;
}

function discoverProjectSkills(startDir: string) {
  const roots = getLocalSearchRoots(startDir);
  const discovered: AgentSkill[] = [];

  for (const root of roots) {
    for (const definition of PROJECT_SKILL_DIRECTORY_DEFINITIONS) {
      const skillsDir = path.join(root, definition.dir);
      const skills = discoverSkillsInDirectory(
        skillsDir,
        definition.sourceKind,
        "project",
      );
      discovered.push(...skills);
    }
  }

  return discovered;
}

function discoverUserSkills() {
  const homeDir = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (!homeDir) return [];

  const discovered: AgentSkill[] = [];
  for (const definition of USER_SKILL_DIRECTORY_DEFINITIONS) {
    const skillsDir = path.join(homeDir, definition.dir);
    const skills = discoverSkillsInDirectory(
      skillsDir,
      definition.sourceKind,
      "user",
    );
    discovered.push(...skills);
  }

  return discovered;
}

export function discoverAgentSkills() {
  try {
    const cwd = process.cwd();
    const projectSkills = discoverProjectSkills(cwd);
    const userSkills = discoverUserSkills();
    return dedupeSkillsByName([...projectSkills, ...userSkills]);
  } catch (error) {
    logger.warn(
      `Skill discovery failed for Bare runtime: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}
