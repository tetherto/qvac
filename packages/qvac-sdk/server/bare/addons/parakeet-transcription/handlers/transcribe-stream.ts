import { getModel } from "@/server/bare/registry/model-registry";
import { Readable } from "bare-stream";
import fs from "bare-fs";
import { needsDecoding, decodeAudioToStream } from "@/server/utils";
import { type TranscribeParams, type AudioFormat } from "@/schemas";
import {
  AudioFileNotFoundError,
  InvalidAudioChunkError,
} from "@/utils/errors-server";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export async function* transcribe(
  params: TranscribeParams,
): AsyncGenerator<string, void, void> {
  const model = getModel(params.modelId);

  // Parakeet expects s16le audio format
  const audioFormat: AudioFormat = "s16le";

  try {
    let audioStream: Readable;

    const audioChunk = params.audioChunk;

    switch (audioChunk.type) {
      case "base64": {
        const audioBuffer = Buffer.from(audioChunk.value, "base64");
        audioStream = Readable.from([audioBuffer]);
        break;
      }
      case "filePath": {
        const filePath = audioChunk.value;
        try {
          fs.accessSync(filePath);
        } catch (error: unknown) {
          throw new AudioFileNotFoundError(filePath, error);
        }

        if (needsDecoding(filePath)) {
          audioStream = await decodeAudioToStream(filePath, audioFormat);
        } else {
          audioStream = fs.createReadStream(filePath) as unknown as Readable;
        }
        break;
      }
      default:
        throw new InvalidAudioChunkError();
    }

    // Run transcription with streaming enabled
    const response = await model.run(audioStream);

    for await (const output of response.iterate()) {
      logger.debug("Streaming Parakeet Transcription Update:", output);
      const text = (output as { text: string }[])
        .map((chunk) => chunk.text)
        .join("");

      if (text.trim()) {
        yield text;
      }
    }
  } finally {
    // No config restoration needed for parakeet (no prompt-based reload pattern)
  }
}
