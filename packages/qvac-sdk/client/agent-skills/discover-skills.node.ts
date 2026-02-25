import { promises as fs } from "fs";
import os from "os";
import path from "path";
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

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(dirPath: string) {
  try {
    const stats = await fs.stat(dirPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function findGitRoot(startDir: string) {
  let currentDir = path.resolve(startDir);
  const root = path.parse(currentDir).root;

  while (true) {
    const gitPath = path.join(currentDir, ".git");
    if (await pathExists(gitPath)) {
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

async function getLocalSearchRoots(startDir: string) {
  const gitRoot = await findGitRoot(startDir);
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

async function discoverSkillsInDirectory(
  skillsDirPath: string,
  sourceKind: AgentSkillSourceKind,
  scope: AgentSkillScope,
) {
  const exists = await directoryExists(skillsDirPath);
  if (!exists) return [];

  const entries = await fs.readdir(skillsDirPath, { withFileTypes: true });
  const sortedEntries = entries
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  const discovered: AgentSkill[] = [];

  for (const entry of sortedEntries) {
    const skillFilePath = path.join(skillsDirPath, entry.name, "SKILL.md");
    if (!(await pathExists(skillFilePath))) {
      continue;
    }

    try {
      const raw = await fs.readFile(skillFilePath, "utf-8");
      const skill = toAgentSkill({
        content: raw,
        sourcePath: skillFilePath,
        sourceKind,
        scope,
        fallbackName: entry.name,
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

async function discoverProjectSkills(startDir: string) {
  const roots = await getLocalSearchRoots(startDir);
  const discovered: AgentSkill[] = [];

  for (const root of roots) {
    for (const definition of PROJECT_SKILL_DIRECTORY_DEFINITIONS) {
      const skillsDir = path.join(root, definition.dir);
      const skills = await discoverSkillsInDirectory(
        skillsDir,
        definition.sourceKind,
        "project",
      );
      discovered.push(...skills);
    }
  }

  return discovered;
}

async function discoverUserSkills() {
  const homeDir = os.homedir();
  if (!homeDir) return [];

  const discovered: AgentSkill[] = [];
  for (const definition of USER_SKILL_DIRECTORY_DEFINITIONS) {
    const skillsDir = path.join(homeDir, definition.dir);
    const skills = await discoverSkillsInDirectory(
      skillsDir,
      definition.sourceKind,
      "user",
    );
    discovered.push(...skills);
  }

  return discovered;
}

export async function discoverAgentSkills() {
  try {
    const cwd = process.cwd();
    const projectSkills = await discoverProjectSkills(cwd);
    const userSkills = await discoverUserSkills();
    return dedupeSkillsByName([...projectSkills, ...userSkills]);
  } catch (error) {
    logger.warn(
      `Skill discovery failed for Node runtime: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}
