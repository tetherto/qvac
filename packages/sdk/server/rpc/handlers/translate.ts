import type {
  TranslateRequest,
  TranslateResponse,
  TranslationStats,
} from "@/schemas";
import { translate } from "@/server/bare/addons/nmtcpp-translation";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export async function* handleTranslate(
  request: TranslateRequest,
): AsyncGenerator<TranslateResponse> {
  try {
    // Remove the 'type' field from request and pass the rest to translate
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { type, ...translateParams } = request;
    const generator = translate(translateParams);
    let stats: TranslationStats | undefined;
    let done = false;
    let buffer = "";

    while (!done) {
      const result = await generator.next();

      if (result.done) {
        stats = result.value;
        done = true;
      } else {
        buffer += result.value;

        if (translateParams.stream) {
          yield {
            type: "translate" as const,
            token: result.value,
          };
        }
      }
    }

    yield {
      type: "translate",
      token: buffer,
      done: true,
      stats,
    };
  } catch (error) {
    logger.error("Error during translation:", error);
    yield {
      type: "translate",
      token: "",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
