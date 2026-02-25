import { z } from "zod";

export const agentSkillSourceKindSchema = z.enum([
  "cursor",
  "claude",
  "codex",
  "agents",
  "opencode",
]);

export const agentSkillScopeSchema = z.enum(["project", "user"]);

export const agentSkillSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  sourcePath: z.string().min(1),
  sourceKind: agentSkillSourceKindSchema,
  scope: agentSkillScopeSchema,
  disableModelInvocation: z.boolean().optional(),
  body: z.string().min(1),
});

export const agentSkillsSchema = z.array(agentSkillSchema);

export type AgentSkillSourceKind = z.infer<typeof agentSkillSourceKindSchema>;
export type AgentSkillScope = z.infer<typeof agentSkillScopeSchema>;
export type AgentSkill = z.infer<typeof agentSkillSchema>;
