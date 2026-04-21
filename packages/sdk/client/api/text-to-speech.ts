import {
  ttsResponseSchema,
  type TtsClientParams,
  type TtsRequest,
  type RPCOptions,
} from "@/schemas";
import { stream as streamRpc } from "@/client/rpc/rpc-client";

/**
 * Converts text to speech audio.
 *
 * Returns an object exposing both a streaming generator of audio samples and
 * a buffered promise for the full output, depending on `params.stream`.
 *
 * @param params - TTS parameters
 * @param params.modelId - The identifier of the loaded TTS model
 * @param params.text - The text to convert to speech (non-empty)
 * @param params.inputType - Input type
 * @default "text"
 * @param params.stream - Whether to stream audio samples or return all at once
 * @default true
 * @param options - Optional RPC transport options
 * @returns An object with:
 *   - `bufferStream`: Stream of audio samples (active when `stream: true`)
 *   - `buffer`: Complete audio buffer (populated when `stream: false`)
 *   - `done`: Resolves to `true` when generation completes
 *
 * @example
 * ```typescript
 * // Streaming mode
 * const { bufferStream } = textToSpeech({ modelId, text: "Hello world" });
 * for await (const sample of bufferStream) {
 *   // process audio sample
 * }
 *
 * // Non-streaming mode
 * const { buffer } = textToSpeech({ modelId, text: "Hello world", stream: false });
 * const audioData = await buffer;
 * ```
 */
export function textToSpeech(
  params: TtsClientParams,
  options?: RPCOptions,
): {
  bufferStream: AsyncGenerator<number>;
  buffer: Promise<number[]>;
  done: Promise<boolean>;
} {
  const request: TtsRequest = {
    type: "textToSpeech",
    modelId: params.modelId,
    inputType: params.inputType,
    text: params.text,
    stream: params.stream,
  };

  let doneResolver: (value: boolean) => void = () => {};
  const donePromise = new Promise<boolean>((resolve) => {
    doneResolver = resolve;
  });

  if (params.stream) {
    const bufferStream = (async function* () {
      for await (const response of streamRpc(request, options)) {
        if (response.type === "textToSpeech") {
          const streamResponse = ttsResponseSchema.parse(response);
          if (streamResponse.buffer.length > 0) {
            yield* streamResponse.buffer;
          }
          if (streamResponse.done) {
            doneResolver(true);
          }
        }
      }
    })();

    return {
      bufferStream,
      buffer: Promise.resolve([]),
      done: donePromise,
    };
  } else {
    const bufferStream = (async function* () {
      //Empty generator for non-streaming mode
    })();

    const bufferPromise = (async () => {
      let buffer: number[] = [];
      for await (const response of streamRpc(request, options)) {
        if (response.type === "textToSpeech") {
          const streamResponse = ttsResponseSchema.parse(response);
          buffer = buffer.concat(streamResponse.buffer);
          if (streamResponse.done) {
            doneResolver(true);
          }
        }
      }
      return buffer;
    })();

    return {
      bufferStream,
      buffer: bufferPromise,
      done: donePromise,
    };
  }
}
