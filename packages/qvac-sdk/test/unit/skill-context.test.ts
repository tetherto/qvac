// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  dedupeSkillsByName,
  parseSkillMarkdown,
  toAgentSkill,
} from "@/client/agent-skills/common";
import { type AgentSkill } from "@/schemas";
import {
  SKILL_CONTEXT_LIMITS,
  injectAgentSkillContextFromSkills,
} from "@/server/utils/skill-context";

function createSkill(overrides: Partial<AgentSkill> = {}): AgentSkill {
  return {
    name: "default-skill",
    description: "Default skill description",
    sourcePath: "/tmp/default/SKILL.md",
    sourceKind: "cursor",
    scope: "project",
    body: "Default skill body",
    ...overrides,
  };
}

test("parseSkillMarkdown parses frontmatter and body", (t) => {
  const content = `---
name: test-skill
description: Test skill description
disable-model-invocation: true
---

Use this skill for testing.`;
  const parsed = parseSkillMarkdown(content);

  t.is(parsed.frontmatter["name"], "test-skill");
  t.is(parsed.frontmatter["description"], "Test skill description");
  t.is(parsed.frontmatter["disable-model-invocation"], "true");
  t.is(parsed.body, "Use this skill for testing.");
});

test("toAgentSkill falls back to folder name and first paragraph", (t) => {
  const content = `Use this fallback paragraph.

Additional instructions below.`;
  const skill = toAgentSkill({
    content,
    sourcePath: "/tmp/fallback/SKILL.md",
    sourceKind: "claude",
    scope: "project",
    fallbackName: "fallback-skill",
  });

  t.ok(skill);
  t.is(skill?.name, "fallback-skill");
  t.is(skill?.description, "Use this fallback paragraph.");
});

test("toAgentSkill parses disable-model-invocation", (t) => {
  const content = `---
name: deploy
description: Deploy skill
disable-model-invocation: true
---

Deploy instructions`;
  const skill = toAgentSkill({
    content,
    sourcePath: "/tmp/deploy/SKILL.md",
    sourceKind: "codex",
    scope: "project",
    fallbackName: "deploy",
  });

  t.ok(skill);
  t.is(skill?.disableModelInvocation, true);
});

test("dedupeSkillsByName keeps first occurrence by input order", (t) => {
  const projectSkill = createSkill({
    name: "release",
    sourcePath: "/project/.cursor/skills/release/SKILL.md",
    scope: "project",
  });
  const userSkill = createSkill({
    name: "RELEASE",
    sourcePath: "/home/.cursor/skills/release/SKILL.md",
    scope: "user",
  });
  const lintSkill = createSkill({ name: "lint" });

  const deduped = dedupeSkillsByName([projectSkill, userSkill, lintSkill]);
  t.is(deduped.length, 2);
  t.is(deduped[0]?.sourcePath, projectSkill.sourcePath);
  t.is(deduped[1]?.name, "lint");
});

test("injectAgentSkillContextFromSkills adds catalog and explicit matched body", (t) => {
  const deploySkill = createSkill({
    name: "deploy-app",
    description: "Deploy the application to production",
    disableModelInvocation: true,
    body: "Run deploy checks and production deploy.",
  });
  const reviewSkill = createSkill({
    name: "review-pr",
    description: "Review pull requests and summarize risks",
    body: "Review checklist",
  });

  const history = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Please run /deploy-app for this release." },
  ];

  const injected = injectAgentSkillContextFromSkills(
    [deploySkill, reviewSkill],
    history,
  );

  const systemMessages = injected.filter((msg) => msg.role === "system");
  t.ok(
    systemMessages.some((msg) =>
      msg.content.includes("[QVAC Agent Skills Catalog]"),
    ),
  );
  t.ok(
    systemMessages.some((msg) =>
      msg.content.includes("[QVAC Agent Skill: deploy-app]"),
    ),
  );
});

test("explicit-only skill is not auto-matched without slash invocation", (t) => {
  const deploySkill = createSkill({
    name: "deploy-app",
    description: "Deploy the application to production",
    disableModelInvocation: true,
    body: "Deploy instructions",
  });
  const history = [
    { role: "user", content: "Can you help with deployment strategy?" },
  ];

  const injected = injectAgentSkillContextFromSkills([deploySkill], history);
  const bodyMessages = injected.filter((msg) =>
    msg.content.includes("[QVAC Agent Skill:"),
  );

  t.is(bodyMessages.length, 0);
  t.ok(
    injected.some((msg) => msg.content.includes("[QVAC Agent Skills Catalog]")),
  );
});

test("injected skill context respects truncation and total limits", (t) => {
  const hugeBody = "x".repeat(SKILL_CONTEXT_LIMITS.maxSkillBodyChars * 3);
  const hugeSkill = createSkill({
    name: "huge-skill",
    description: "A very large skill body for truncation tests",
    body: hugeBody,
  });
  const history = [{ role: "user", content: "Please run /huge-skill now." }];

  const injected = injectAgentSkillContextFromSkills([hugeSkill], history);
  const injectedOnly = injected.slice(0, injected.length - history.length);
  const totalInjectedChars = injectedOnly.reduce(
    (sum, message) => sum + message.content.length,
    0,
  );

  t.ok(totalInjectedChars <= SKILL_CONTEXT_LIMITS.maxTotalInjectedChars);
  t.ok(injectedOnly.some((message) => message.content.includes("[truncated]")));
});
