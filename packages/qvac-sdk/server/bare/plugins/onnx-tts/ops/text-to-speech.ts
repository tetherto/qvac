import { getModel } from "@/server/bare/registry/model-registry";
import { ttsRequestSchema, type TtsRequest, type TtsResponse } from "@/schemas";

export async function* textToSpeech(
  params: TtsRequest,
): AsyncGenerator<TtsResponse> {
  const { modelId, inputType, text, stream } = ttsRequestSchema.parse(params);

  const model = getModel(modelId);

  const response = await model.run({ input: text, inputType });

  if (!stream) {
    // Non-streaming mode: wait for complete response and yield once
    let completeBuffer: number[] = [];

    await response
      .onUpdate((data: { outputArray: Int16Array }) => {
        completeBuffer = completeBuffer.concat(Array.from(data.outputArray));
      })
      .await();

    yield {
      type: "textToSpeech",
      buffer: completeBuffer,
      done: true,
    };
  } else {
    // Streaming mode: use async iterator pattern
    const outputQueue: { outputArray: Int16Array }[] = [];
    let isComplete = false;
    let streamError: unknown = null;
    let resolveNext: ((value: IteratorResult<TtsResponse>) => void) | null =
      null;
    let rejectNext: ((reason: unknown) => void) | null = null;

    // Start the response processing
    const responsePromise = response
      .onUpdate((data: { outputArray: Int16Array }) => {
        if (resolveNext) {
          // If there's a pending read, resolve it immediately
          resolveNext({
            value: {
              type: "textToSpeech",
              buffer: Array.from(data.outputArray),
              done: false,
            },
            done: false,
          });
          resolveNext = null;
          rejectNext = null;
        } else {
          // Otherwise, queue the output
          outputQueue.push(data);
        }
      })
      .await()
      .then(() => {
        isComplete = true;
        if (resolveNext) {
          resolveNext({ value: undefined, done: true });
          resolveNext = null;
          rejectNext = null;
        }
      })
      .catch((err: unknown) => {
        streamError = err;
        isComplete = true;
        if (rejectNext) {
          rejectNext(err);
          resolveNext = null;
          rejectNext = null;
        }
      });

    // Create an async iterator
    const asyncIterator = {
      async next(): Promise<IteratorResult<TtsResponse>> {
        if (streamError) {
          if (streamError instanceof Error) throw streamError;
          const message =
            typeof streamError === "string"
              ? streamError
              : JSON.stringify(streamError);
          throw new Error(message);
        }

        if (outputQueue.length > 0) {
          const data = outputQueue.shift()!;
          return {
            value: {
              type: "textToSpeech",
              buffer: Array.from(data.outputArray),
              done: false,
            },
            done: false,
          };
        }

        if (isComplete) {
          return { value: undefined, done: true };
        }

        // Wait for the next output
        return new Promise<IteratorResult<TtsResponse>>((resolve, reject) => {
          resolveNext = resolve;
          rejectNext = reject;
        });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };

    // Yield outputs as they come
    for await (const output of asyncIterator) {
      yield output;
    }

    // Ensure the response is fully processed
    await responsePromise;
  }
}
