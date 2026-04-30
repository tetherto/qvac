import fs from "bare-fs";
import path from "bare-path";
import { FFmpegDecoder } from "@qvac/decoder-audio";
import { FORMATS_NEEDING_DECODE } from "@qvac/decoder-audio/constants";
import { Readable } from "bare-stream";
import { getServerLogger } from "@/logging";
import { type AudioFormat } from "@/schemas";

const logger = getServerLogger();

export function needsDecoding(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return FORMATS_NEEDING_DECODE.includes(ext);
}

const DECODER_TIMEOUT_MS = 10000;

export async function decodeAudioToStream(
  inputPath: string,
  audioFormat: AudioFormat = "s16le",
): Promise<Readable> {
  const decoder = new FFmpegDecoder({
    config: { audioFormat },
    logger,
  });

  try {
    await decoder.load();

    const audioStream = fs.createReadStream(inputPath);
    const response = await decoder.run(audioStream);

    const outputStream = new Readable({
      read() {},
    });

    let hasReceivedData = false;
    let hasEnded = false;

    // Fallback timeout in case the decoder hangs without emitting any events
    const timeoutId = setTimeout(() => {
      if (!hasEnded) {
        hasEnded = true;
        const timeoutError = new Error(
          `Audio decoding timed out after ${DECODER_TIMEOUT_MS}ms for file: ${inputPath}`,
        );
        outputStream.destroy(timeoutError);
      }
    }, DECODER_TIMEOUT_MS);

    response
      .onUpdate((output) => {
        hasReceivedData = true;
        const bytes = new Uint8Array(output.outputArray);
        outputStream.push(Buffer.from(bytes));
      })
      .onFinish(() => {
        if (!hasEnded) {
          hasEnded = true;
          clearTimeout(timeoutId);
          setImmediate(() => void decoder.unload());
          if (!hasReceivedData) {
            outputStream.destroy(
              new Error(`No audio data decoded from file: ${inputPath}`),
            );
          } else {
            outputStream.push(null);
          }
        }
      })
      .onError((error: Error) => {
        if (!hasEnded) {
          hasEnded = true;
          clearTimeout(timeoutId);
          setImmediate(() => void decoder.unload());
          outputStream.destroy(error);
        }
      });

    response.await().catch((error) => {
      if (!hasEnded) {
        hasEnded = true;
        clearTimeout(timeoutId);
        setImmediate(() => void decoder.unload());
        outputStream.destroy(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });

    return outputStream;
  } catch (error) {
    await decoder.unload();
    logger.error(
      "Decoding failed:",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}
