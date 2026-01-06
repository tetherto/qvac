import { z } from "zod";

/**
 * Mobile Consumer Environment Configuration
 * 
 * Note: Mobile apps (React Native/Expo) do not support CLI arguments.
 * All configuration must be provided via environment variables or .env files.
 * 
 * For dynamic runId during builds, use:
 * - EXPO_PUBLIC_RUN_ID=my-run-id npx expo start
 * - Or add to .env file: EXPO_PUBLIC_RUN_ID=my-run-id
 */

const envSchema = z.object({
  // Test runner config (using process.env for Expo)
  LLM_MODEL_URL: z.string().optional(),
  WHISPER_MODEL_URL: z.string().optional(),
  // MQTT config (optional, for legacy support)
  EXPO_PUBLIC_MQTT_SSL: z.enum(["true", "false"]).default("false"),
  EXPO_PUBLIC_MQTT_HOST: z.string().default("10.0.2.2"), // Emulator default, override in .env for physical device
  EXPO_PUBLIC_MQTT_PORT: z.coerce.number().int().positive().default(8080),
  EXPO_PUBLIC_MQTT_PORT_SSL: z.coerce.number().int().positive().default(8081),
  EXPO_PUBLIC_MQTT_PATH: z.string().default(""),
  EXPO_PUBLIC_MQTT_TOPICS: z.string().default("qvac/test"),
  EXPO_PUBLIC_RUN_ID: z.string().default("*"),
});

const parsed = envSchema.parse({
  LLM_MODEL_URL: process.env.LLM_MODEL_URL,
  WHISPER_MODEL_URL: process.env.WHISPER_MODEL_URL,
  EXPO_PUBLIC_MQTT_SSL: process.env.EXPO_PUBLIC_MQTT_SSL,
  EXPO_PUBLIC_MQTT_HOST: process.env.EXPO_PUBLIC_MQTT_HOST,
  EXPO_PUBLIC_MQTT_PORT: process.env.EXPO_PUBLIC_MQTT_PORT,
  EXPO_PUBLIC_MQTT_PORT_SSL: process.env.EXPO_PUBLIC_MQTT_PORT_SSL,
  EXPO_PUBLIC_MQTT_PATH: process.env.EXPO_PUBLIC_MQTT_PATH,
  EXPO_PUBLIC_MQTT_TOPICS:
    process.env.EXPO_PUBLIC_MQTT_TOPICS ?? process.env.EXPO_PUBLIC_MQTT_TOPIC,
  EXPO_PUBLIC_RUN_ID: process.env.EXPO_PUBLIC_RUN_ID,
});

const topics = parsed.EXPO_PUBLIC_MQTT_TOPICS.split(",")
  .map((item) => item.trim())
  .filter(Boolean);

export const env = {
  ...parsed,
  topics,
  useSsl: parsed.EXPO_PUBLIC_MQTT_SSL === "true",
  RUN_ID: parsed.EXPO_PUBLIC_RUN_ID,
};

export type Env = typeof env;
