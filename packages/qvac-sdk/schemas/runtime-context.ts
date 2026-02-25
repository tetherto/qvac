import { z } from "zod";
import { agentSkillsSchema } from "./agent-skills";

export const runtimeContextSchema = z.object({
  runtime: z.enum(["node", "bare", "react-native"]).optional(),
  platform: z.enum(["android", "ios", "darwin", "linux", "win32"]).optional(),
  deviceModel: z.string().optional(),
  deviceBrand: z.string().optional(),
  agentSkills: agentSkillsSchema.optional(),
});

export type RuntimeContext = z.infer<typeof runtimeContextSchema>;
