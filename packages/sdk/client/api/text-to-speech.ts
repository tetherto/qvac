import {
  ttsResponseSchema,
  type TtsClientParams,
  type TtsRequest,
  type RPCOptions,
} from "@/schemas";
import { stream as streamRpc } from "@/client/rpc/rpc-client";

/**
 * Converts text to speech audio using a loaded TTS model.
 *
 * @param params - TTS request parameters.
 * @param params.modelId - The identifier of the TTS model to use.
 * @param params.inputType - Kind of input text (plain string, SSML, etc. — see `TtsClientParams`).
 * @param params.text - The text to synthesize.
 * @param params.stream - Whether to stream the audio buffer (`true`) or resolve it once (`false`).
 * @param options - Optional RPC options (timeout, profiling, force new connection, etc.).
 * @returns An object with `bufferStream` (async generator of PCM sample numbers; populated only when `stream: true`), `buffer` (a promise resolving to the complete `number[]` when `stream: false`), and `done` (a promise resolving to `true` when synthesis finishes).
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
