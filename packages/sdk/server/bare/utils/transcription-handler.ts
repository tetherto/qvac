import {
  defineHandler,
  transcribeStreamRequestSchema,
  transcribeStreamResponseSchema,
  type TranscribeParams,
} from "@/schemas";

type TranscribeFn = (
  params: TranscribeParams,
) => AsyncGenerator<string, void, void>;

/**
 * Creates a standard `transcribeStream` handler definition for a
 * transcription plugin.  Every transcription addon (Whisper, Parakeet, …)
 * follows the same yield-then-done protocol — this helper avoids
 * duplicating that boilerplate across plugins.
 */
export function createTranscribeStreamHandler(transcribeFn: TranscribeFn) {
  return defineHandler({
    requestSchema: transcribeStreamRequestSchema,
    responseSchema: transcribeStreamResponseSchema,
    streaming: true,

    handler: async function* (request) {
      for await (const text of transcribeFn({
        modelId: request.modelId,
        audioChunk: request.audioChunk,
        prompt: request.prompt,
      })) {
        yield {
          type: "transcribeStream" as const,
          text,
        };
      }

      yield {
        type: "transcribeStream" as const,
        text: "",
        done: true,
      };
    },
  });
}
