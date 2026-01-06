import {
  ttsResponseSchema,
  type TtsClientParams,
  type TtsRequest,
} from "@/schemas";
import { stream as streamRpc } from "@/client/rpc/rpc-client";

export function textToSpeech(params: TtsClientParams): {
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
      for await (const response of streamRpc(request)) {
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
      for await (const response of streamRpc(request)) {
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
