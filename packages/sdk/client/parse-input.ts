import { z } from "zod";
import { formatZodError } from "@/utils/zod-error";
import { RequestValidationFailedError } from "@/utils/errors-client";

export function parseClientInput<S extends z.ZodType>(
  schema: S,
  value: unknown,
): z.output<S> {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new RequestValidationFailedError(formatZodError(error));
    }
    throw error;
  }
}
