import { getModel } from "@/server/bare/registry/model-registry";
import fs from "bare-fs";
import path from "bare-path";
import { type OCRParams, type OCRTextBlock, type OCRStats } from "@/schemas";
import { buildStreamResult, hasDefinedValues } from "@/profiling/model-execution";
import { getCacheDir } from "@/server/utils";
import {
  ImageFileNotFoundError,
  InvalidImageInputError,
} from "@/utils/errors-server";
import { nowMs } from "@/profiling";

interface OCRResponse {
  onUpdate: (callback: (data: unknown) => unknown[]) => {
    await: () => Promise<unknown>;
  };
  stats?: {
    detectionTime?: number;
    recognitionTime?: number;
    totalTime?: number;
  };
}

type Polygon = [number, number][];
type BBox = [number, number, number, number];

function polygonToBbox(polygon: Polygon): BBox {
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function normalizeBlock(block: unknown): OCRTextBlock | null {
  if (
    block &&
    typeof block === "object" &&
    !Array.isArray(block) &&
    "text" in block
  ) {
    const obj = block as {
      text?: string;
      bbox?: BBox;
      confidence?: number;
    };
    return {
      text: obj.text || "",
      ...(obj.bbox && { bbox: obj.bbox }),
      ...(obj.confidence !== undefined && { confidence: obj.confidence }),
    };
  }

  // Addon format: [polygon, text, confidence] where polygon is [[x1,y1], [x2,y2], [x3,y3], [x4,y4]]
  if (Array.isArray(block) && block.length >= 2) {
    const blockArr = block as [unknown, unknown, unknown?];
    const [polygonOrBbox, text, confidence] = blockArr;
    const textStr = typeof text === "string" ? text : "";

    if (
      Array.isArray(polygonOrBbox) &&
      polygonOrBbox.length === 4 &&
      Array.isArray(polygonOrBbox[0]) &&
      polygonOrBbox[0].length === 2
    ) {
      return {
        text: textStr,
        bbox: polygonToBbox(polygonOrBbox as Polygon),
        ...(confidence !== undefined && { confidence: Number(confidence) }),
      };
    }

    if (
      Array.isArray(polygonOrBbox) &&
      polygonOrBbox.length === 4 &&
      typeof polygonOrBbox[0] === "number"
    ) {
      return {
        text: textStr,
        bbox: polygonOrBbox as BBox,
        ...(confidence !== undefined && { confidence: Number(confidence) }),
      };
    }
  }

  return null;
}

export async function* ocr(params: OCRParams): AsyncGenerator<
  { blocks: OCRTextBlock[] },
  { modelExecutionMs: number; stats?: OCRStats },
  void
> {
  const model = getModel(params.modelId);

  let imagePath: string;
  let cleanupPath: string | null = null;

  switch (params.image.type) {
    case "base64": {
      const tempDir = getCacheDir("tmp");
      const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const tempPath = path.join(tempDir, `ocr-${suffix}.png`);
      fs.writeFileSync(tempPath, Buffer.from(params.image.value, "base64"));
      imagePath = tempPath;
      cleanupPath = tempPath;
      break;
    }
    case "filePath": {
      imagePath = params.image.value;
      try {
        fs.accessSync(imagePath);
      } catch (error: unknown) {
        throw new ImageFileNotFoundError(imagePath, error);
      }
      break;
    }
    default:
      throw new InvalidImageInputError();
  }

  try {
    const modelStart = nowMs();
    const response = (await model.run({
      path: imagePath,
      ...(params.options && { options: params.options }),
    })) as unknown as OCRResponse;

    const rawData: unknown[] = [];
    await response
      .onUpdate((data: unknown) => {
        rawData.push(data);
        return [];
      })
      .await();
    const modelExecutionMs = nowMs() - modelStart;

    const blocks = rawData
      .flat(1)
      .map(normalizeBlock)
      .filter((b): b is OCRTextBlock => b !== null);

    if (blocks.length > 0) {
      yield { blocks };
    }

    const stats: OCRStats = {
      ...(response.stats?.detectionTime !== undefined && { detectionTime: response.stats.detectionTime }),
      ...(response.stats?.recognitionTime !== undefined && { recognitionTime: response.stats.recognitionTime }),
      ...(response.stats?.totalTime !== undefined && { totalTime: response.stats.totalTime }),
    };

    return buildStreamResult(modelExecutionMs, hasDefinedValues(stats) ? stats : undefined);
  } finally {
    if (cleanupPath) {
      try {
        fs.unlinkSync(cleanupPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}
