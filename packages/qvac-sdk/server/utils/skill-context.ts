import { getAgentSkills } from "@/server/bare/registry/runtime-context-registry";
import type { AgentSkill } from "@/schemas";

type HistoryMessage = {
  role: string;
  content: string;
  attachments?: { path: string }[] | undefined;
};

type MatchedSkill = {
  skill: AgentSkill;
  explicit: boolean;
  score: number;
};

export const SKILL_CONTEXT_LIMITS = {
  maxCatalogSkills: 80,
  maxMatchedSkills: 4,
  maxCatalogChars: 6000,
  maxSkillBodyChars: 3000,
  maxTotalInjectedChars: 14000,
} as const;

const TRUNCATION_MARKER = "\n...[truncated]";

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function tokenize(value: string) {
  const matches = value.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? [];
  return new Set(matches.filter((token) => token.length >= 3));
}

function getLastUserMessage(history: HistoryMessage[]) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    if (message?.role === "user") {
      return message.content;
    }
  }
  return "";
}

function getExplicitInvocations(prompt: string) {
  const explicit = new Set<string>();
  const matches = prompt.toLowerCase().matchAll(/\/([a-z0-9]+(?:-[a-z0-9]+)*)/g);
  for (const match of matches) {
    const name = match[1]?.trim();
    if (name) explicit.add(name);
  }
  return explicit;
}

function getSkillScore(
  skill: AgentSkill,
  promptLower: string,
  promptTokens: Set<string>,
  explicitInvocations: Set<string>,
) {
  const normalizedName = skill.name.toLowerCase();
  const explicit = explicitInvocations.has(normalizedName);
  const skillTokens = tokenize(`${skill.name} ${skill.description}`);

  let overlap = 0;
  for (const token of skillTokens) {
    if (promptTokens.has(token)) {
      overlap += 1;
    }
  }

  let score = overlap;
  if (promptLower.includes(normalizedName)) {
    score += 2;
  }

  return { explicit, score };
}

function selectMatchedSkills(skills: AgentSkill[], latestUserMessage: string) {
  if (latestUserMessage.trim().length === 0) return [];

  const promptLower = latestUserMessage.toLowerCase();
  const promptTokens = tokenize(latestUserMessage);
  const explicitInvocations = getExplicitInvocations(latestUserMessage);
  const matched: MatchedSkill[] = [];

  for (const skill of skills) {
    const { explicit, score } = getSkillScore(
      skill,
      promptLower,
      promptTokens,
      explicitInvocations,
    );
    if (!explicit && skill.disableModelInvocation) {
      continue;
    }

    if (explicit || score >= 2) {
      matched.push({ skill, explicit, score });
    }
  }

  matched.sort((a, b) => {
    if (a.explicit !== b.explicit) return a.explicit ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    return a.skill.name.localeCompare(b.skill.name);
  });

  return matched.slice(0, SKILL_CONTEXT_LIMITS.maxMatchedSkills);
}

function truncateWithMarker(value: string, maxChars: number) {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  if (maxChars <= TRUNCATION_MARKER.length) {
    return value.slice(0, maxChars);
  }
  return value.slice(0, maxChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

function buildCatalogMessage(skills: AgentSkill[]) {
  const sorted = skills
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, SKILL_CONTEXT_LIMITS.maxCatalogSkills);

  const lines: string[] = [
    "[QVAC Agent Skills Catalog]",
    "These skills are available from local skill directories.",
    "Use them when relevant. Skills marked explicit-only should only be used via /skill-name.",
  ];

  for (const skill of sorted) {
    const description = normalizeWhitespace(skill.description);
    const explicitOnly = skill.disableModelInvocation ? " explicit-only" : "";
    lines.push(
      `- ${skill.name}: ${description} [${skill.sourceKind}/${skill.scope}${explicitOnly}]`,
    );
  }

  const full = lines.join("\n");
  return truncateWithMarker(full, SKILL_CONTEXT_LIMITS.maxCatalogChars);
}

function buildSkillBodyMessage(skill: AgentSkill, maxChars: number) {
  const headerLines = [
    `[QVAC Agent Skill: ${skill.name}]`,
    `Source: ${skill.sourcePath}`,
    `Description: ${normalizeWhitespace(skill.description)}`,
    "Instructions:",
  ];
  const header = headerLines.join("\n");
  const availableForBody = Math.max(0, maxChars - header.length - 1);
  const body = truncateWithMarker(skill.body.trim(), availableForBody);
  if (body.length === 0) {
    return truncateWithMarker(header, maxChars);
  }
  return `${header}\n${body}`;
}

function getInsertionIndex(history: HistoryMessage[]) {
  let insertionIndex = -1;
  for (let i = 0; i < history.length; i += 1) {
    const message = history[i];
    if (message?.role === "system") {
      insertionIndex = i;
      continue;
    }
    break;
  }
  return insertionIndex;
}

function toSystemMessage(content: string): HistoryMessage {
  return { role: "system", content };
}

export function injectAgentSkillContext(history: HistoryMessage[]) {
  const skills = getAgentSkills();
  return injectAgentSkillContextFromSkills(skills, history);
}

export function injectAgentSkillContextFromSkills(
  skills: AgentSkill[],
  history: HistoryMessage[],
) {
  if (skills.length === 0) return history;

  const latestUserMessage = getLastUserMessage(history);
  const matched = selectMatchedSkills(skills, latestUserMessage);
  const injectedMessages: HistoryMessage[] = [];
  let remainingBudget = SKILL_CONTEXT_LIMITS.maxTotalInjectedChars;

  const catalogMessage = buildCatalogMessage(skills);
  if (catalogMessage.length > 0 && remainingBudget > 0) {
    const catalogContent = truncateWithMarker(catalogMessage, remainingBudget);
    injectedMessages.push(toSystemMessage(catalogContent));
    remainingBudget -= catalogContent.length;
  }

  for (const entry of matched) {
    if (remainingBudget <= 0) {
      break;
    }
    const maxForSkill = Math.min(
      SKILL_CONTEXT_LIMITS.maxSkillBodyChars,
      remainingBudget,
    );
    const content = buildSkillBodyMessage(entry.skill, maxForSkill);
    if (content.length === 0) {
      continue;
    }
    injectedMessages.push(toSystemMessage(content));
    remainingBudget -= content.length;
  }

  if (injectedMessages.length === 0) return history;

  const insertionIndex = getInsertionIndex(history);
  if (insertionIndex === -1) {
    return [...injectedMessages, ...history];
  }

  return [
    ...history.slice(0, insertionIndex + 1),
    ...injectedMessages,
    ...history.slice(insertionIndex + 1),
  ];
}
