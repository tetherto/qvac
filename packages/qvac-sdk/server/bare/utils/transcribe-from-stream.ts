import { Readable } from "bare-stream";
import fs from "bare-fs";
import { needsDecoding, decodeAudioToStream } from "@/server/utils";
import { type TranscribeParams, type AudioFormat } from "@/schemas";
import {
  AudioFileNotFoundError,
  InvalidAudioChunkError,
} from "@/utils/errors-server";
import { getServerLogger } from "@/logging";
import { type AnyModel } from "@/server/bare/registry/model-registry";

const logger = getServerLogger();

export interface TranscribeFromStreamOptions {
  model: AnyModel;
  params: TranscribeParams;
  audioFormat: AudioFormat;
  filterOutput?: (chunks: { text: string }[]) => { text: string }[];
  logPrefix?: string;
}

/**
 * Shared transcription logic for streaming addons (whisper, parakeet, etc).
 * Resolves audio input (base64 or filePath), decodes if needed, runs the
 * model, and yields text chunks.
 */
export async function* transcribeFromStream(
  opts: TranscribeFromStreamOptions,
): AsyncGenerator<string, void, void> {
  const { model, params, audioFormat, filterOutput, logPrefix = "" } = opts;

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

  const response = await model.run(audioStream);

  for await (const output of response.iterate()) {
    logger.debug(`${logPrefix}Streaming Transcription Update:`, output);

    let chunks = output as { text: string }[];
    if (filterOutput) {
      chunks = filterOutput(chunks);
    }

    const text = chunks.map((chunk) => chunk.text).join("");

    if (text.trim()) {
      yield text;
    }
  }
}
