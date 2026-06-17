import { z } from "zod";

export function formatZodError(error: z.ZodError): string {
  return z.prettifyError(error);
}
