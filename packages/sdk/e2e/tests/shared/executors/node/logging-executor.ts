import { ocr, transcribe } from "@qvac/sdk";
import * as path from "node:path";
import { LoggingExecutor } from "../logging-executor.js";

interface AudioParams { audioFileName: string }
interface ImageParams { imageFileName: string }

const ASSETS_DIRS = {
  audio: "assets/audio",
  images: "assets/images",
} as const;

type AssetCategory = keyof typeof ASSETS_DIRS;

export class NodeLoggingExecutor extends LoggingExecutor {
  protected override triggerWhisper(modelId: string, params: AudioParams): Promise<void> {
    return this.runTranscribe(modelId, params);
  }

  protected override triggerParakeet(modelId: string, params: AudioParams): Promise<void> {
    return this.runTranscribe(modelId, params);
  }

  protected override async triggerOcr(modelId: string, params: ImageParams): Promise<void> {
    const { blocks } = ocr({
      modelId,
      image: this.resolveAsset("images", params.imageFileName),
      stream: false,
    });
    await blocks;
  }

  private async runTranscribe(modelId: string, params: AudioParams): Promise<void> {
    await transcribe({
      modelId,
      audioChunk: this.resolveAsset("audio", params.audioFileName),
    });
  }

  private resolveAsset(category: AssetCategory, filename: string): string {
    return path.resolve(process.cwd(), ASSETS_DIRS[category], filename);
  }
}
