import {
  getModel,
  getModelConfig,
} from "@/server/bare/registry/model-registry";
import { Readable } from "bare-stream";
import fs from "bare-fs";
import { needsDecoding, decodeAudioToStream } from "@/server/utils";
import {
  type TranscribeParams,
  type WhisperConfig,
  type AudioFormat,
} from "@/schemas";
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
  const modelConfig = getModelConfig(params.modelId) as WhisperConfig;
  let originalConfig: WhisperConfig | null = null;
  const audioFormat = (modelConfig.audio_format as AudioFormat) || "s16le";

  if (params.prompt && typeof model.reload === "function") {
    originalConfig = modelConfig;
    const updatedConfig = {
      ...originalConfig,
      initial_prompt: params.prompt,
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { contextParams: _, miscConfig, ...whisperParams } = updatedConfig;

    await model.reload({
      whisperConfig: whisperParams,
      ...(miscConfig && { miscConfig }),
    });
  }

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
      logger.debug("Streaming Transcription Update:", output);
      // Filter out blank audio chunks and process the text
      const text = (output as { text: string }[])
        .filter((chunk) => !chunk.text.includes("[BLANK_AUDIO]"))
        .map((chunk) => chunk.text)
        .join("");

      if (text.trim()) {
        yield text;
      }
    }
  } finally {
    if (originalConfig && typeof model.reload === "function") {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { contextParams: _, miscConfig, ...whisperParams } = originalConfig;

      await model.reload({
        whisperConfig: {
          ...whisperParams,
          initial_prompt: "",
        },
        ...(miscConfig && { miscConfig }),
      });
    }
  }
}
