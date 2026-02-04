import { z } from "zod";

export const runtimeContextSchema = z.object({
  runtime: z.enum(["node", "bare", "react-native"]).optional(),
  platform: z.enum(["android", "ios", "darwin", "linux", "win32"]).optional(),
  deviceModel: z.string().optional(),
  deviceBrand: z.string().optional(),
});

export type RuntimeContext = z.infer<typeof runtimeContextSchema>;
