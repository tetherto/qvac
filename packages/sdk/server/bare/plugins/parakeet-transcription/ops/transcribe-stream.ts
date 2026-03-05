import { getModel } from "@/server/bare/registry/model-registry";
import type { TranscribeParams, AudioFormat } from "@/schemas";
import { createAudioStream } from "@/server/bare/utils/audio-input";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export async function* transcribe(
  params: TranscribeParams,
): AsyncGenerator<string, void, void> {
  const model = getModel(params.modelId);
  const audioFormat: AudioFormat = "s16le";

  const audioStream = await createAudioStream(params.audioChunk, audioFormat);

  const response = await model.run(audioStream);

  for await (const output of response.iterate()) {
    logger.debug("Parakeet Streaming Transcription Update:", output);

    const text = (output as { text: string }[])
      .filter((chunk) => !chunk.text.includes("[No speech detected]"))
      .map((chunk) => chunk.text)
      .join("");

    if (text.trim()) {
      yield text;
    }
  }
}
