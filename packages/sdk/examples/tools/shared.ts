import { z } from "zod";
import type { ToolInput } from "@qvac/sdk";

export const weatherSchema = z.object({
  city: z.string().describe("City name"),
  country: z.string().describe("Country code").optional(),
});

export const horoscopeSchema = z.object({
  sign: z.string().describe("An astrological sign like Taurus or Aquarius"),
});

export const toolSchemas = {
  get_weather: weatherSchema,
  get_horoscope: horoscopeSchema,
} as const;

export const tools: ToolInput[] = [
  {
    name: "get_weather",
    description: "Get current weather for a city",
    parameters: weatherSchema,
  },
  {
    name: "get_horoscope",
    description: "Get today's horoscope for an astrological sign",
    parameters: horoscopeSchema,
  },
];

export function mockExecute(
  name: string,
  args: Record<string, unknown>,
): string {
  if (name === "get_weather") {
    const a = args as { city: string; country?: string };
    return JSON.stringify({
      city: a.city,
      country: a.country ?? "unknown",
      temperature: "22°C",
      condition: "Partly cloudy",
    });
  }
  if (name === "get_horoscope") {
    return JSON.stringify({
      sign: (args as { sign: string }).sign,
      horoscope: "Today is a great day for new beginnings.",
    });
  }
  return JSON.stringify({ error: `Unknown tool: ${name}` });
}
