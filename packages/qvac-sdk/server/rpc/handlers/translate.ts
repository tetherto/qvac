import type {
  TranslateRequest,
  TranslateResponse,
  TranslationStats,
} from "@/schemas";
import { translate } from "@/server/bare/addons/translation";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export async function* handleTranslate(
  request: TranslateRequest,
): AsyncGenerator<TranslateResponse> {
  const { modelId, text, stream, modelType } = request;
  const from = request.modelType === "llm" ? request.from : undefined;
  const to = request.modelType === "llm" ? request.to : undefined;
  const context = request.modelType === "llm" ? request.context : undefined;
  try {
    const generator = translate({
      modelId,
      text,
      from,
      to: to!,
      stream,
      modelType,
      context,
    });
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

        if (stream) {
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
