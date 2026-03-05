import { Readable } from "bare-stream";
import fs from "bare-fs";
import {
  needsDecoding,
  decodeAudioToStream,
} from "@/server/utils/audio/decoder";
import type { AudioInput, AudioFormat } from "@/schemas";
import {
  AudioFileNotFoundError,
  InvalidAudioChunkError,
} from "@/utils/errors-server";

/**
 * Converts an AudioInput (base64 or filePath) into a Readable stream,
 * decoding the audio when necessary.
 *
 * Shared by all transcription plugins (Whisper, Parakeet, etc.).
 */
export async function createAudioStream(
  audioChunk: AudioInput,
  audioFormat: AudioFormat,
): Promise<Readable> {
  switch (audioChunk.type) {
    case "base64": {
      const audioBuffer = Buffer.from(audioChunk.value, "base64");
      return Readable.from([audioBuffer]);
    }
    case "filePath": {
      const filePath = audioChunk.value;
      try {
        fs.accessSync(filePath);
      } catch (error: unknown) {
        throw new AudioFileNotFoundError(filePath, error);
      }

      if (needsDecoding(filePath)) {
        return decodeAudioToStream(filePath, audioFormat);
      }
      return fs.createReadStream(filePath) as unknown as Readable;
    }
    default:
      throw new InvalidAudioChunkError();
  }
}
