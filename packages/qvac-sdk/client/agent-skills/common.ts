import {
  agentSkillSchema,
  type AgentSkill,
  type AgentSkillScope,
  type AgentSkillSourceKind,
} from "@/schemas/agent-skills";

export type SkillDirectoryDefinition = {
  dir: string;
  sourceKind: AgentSkillSourceKind;
};

export const PROJECT_SKILL_DIRECTORY_DEFINITIONS: SkillDirectoryDefinition[] = [
  { dir: ".cursor/skills", sourceKind: "cursor" },
  { dir: ".claude/skills", sourceKind: "claude" },
  { dir: ".codex/skills", sourceKind: "codex" },
  { dir: ".agents/skills", sourceKind: "agents" },
  { dir: ".opencode/skills", sourceKind: "opencode" },
];

export const USER_SKILL_DIRECTORY_DEFINITIONS: SkillDirectoryDefinition[] = [
  { dir: ".cursor/skills", sourceKind: "cursor" },
  { dir: ".claude/skills", sourceKind: "claude" },
  { dir: ".codex/skills", sourceKind: "codex" },
  { dir: ".agents/skills", sourceKind: "agents" },
  { dir: ".config/opencode/skills", sourceKind: "opencode" },
];

export type ParsedSkillContent = {
  frontmatter: Record<string, string>;
  body: string;
};

export function normalizeNewlines(value: string) {
  return value.replace(/\r\n/g, "\n");
}

export function removeUtf8Bom(value: string) {
  if (value.charCodeAt(0) === 0xfeff) {
    return value.slice(1);
  }
  return value;
}

export function trimOptionalQuotes(value: string) {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseSimpleFrontmatter(frontmatterContent: string) {
  const result: Record<string, string> = {};
  const lines = frontmatterContent.split("\n");

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key.length === 0) {
      continue;
    }
    result[key] = trimOptionalQuotes(value);
  }

  return result;
}

export function parseSkillMarkdown(content: string): ParsedSkillContent {
  const normalized = normalizeNewlines(removeUtf8Bom(content));
  if (!normalized.startsWith("---\n")) {
    return {
      frontmatter: {},
      body: normalized.trim(),
    };
  }

  const closingFrontmatterIndex = normalized.indexOf("\n---\n", 4);
  if (closingFrontmatterIndex === -1) {
    return {
      frontmatter: {},
      body: normalized.trim(),
    };
  }

  const frontmatterRaw = normalized.slice(4, closingFrontmatterIndex);
  const body = normalized.slice(closingFrontmatterIndex + 5).trim();
  return {
    frontmatter: parseSimpleFrontmatter(frontmatterRaw),
    body,
  };
}

export function toBoolean(value: string | undefined) {
  if (!value) return undefined;
  const lower = value.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  return undefined;
}

export function firstBodyParagraph(body: string) {
  const paragraphs = body
    .split("\n\n")
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  if (paragraphs.length === 0) {
    return undefined;
  }
  return paragraphs[0];
}

export function toAgentSkill(params: {
  content: string;
  sourcePath: string;
  sourceKind: AgentSkillSourceKind;
  scope: AgentSkillScope;
  fallbackName: string;
}) {
  const parsed = parseSkillMarkdown(params.content);
  const body = parsed.body.trim();
  if (body.length === 0) return undefined;

  const name = (parsed.frontmatter["name"] ?? params.fallbackName).trim();
  if (name.length === 0) return undefined;

  const fallbackDescription = firstBodyParagraph(body);
  const description = (
    parsed.frontmatter["description"] ?? fallbackDescription
  )?.trim();
  if (!description || description.length === 0) return undefined;

  const candidate: AgentSkill = {
    name,
    description,
    sourcePath: params.sourcePath,
    sourceKind: params.sourceKind,
    scope: params.scope,
    disableModelInvocation: toBoolean(
      parsed.frontmatter["disable-model-invocation"],
    ),
    body,
  };

  const parsedCandidate = agentSkillSchema.safeParse(candidate);
  if (!parsedCandidate.success) return undefined;
  return parsedCandidate.data;
}

export function dedupeSkillsByName(skills: AgentSkill[]) {
  const seenNames = new Set<string>();
  const deduped: AgentSkill[] = [];

  for (const skill of skills) {
    const key = skill.name.trim().toLowerCase();
    if (key.length === 0 || seenNames.has(key)) {
      continue;
    }
    seenNames.add(key);
    deduped.push(skill);
  }

  return deduped;
}
