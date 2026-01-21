import ONNXBase, { Loader } from "@qvac/infer-base";

declare interface ONNXOcrParams {
  pathDetector: string;
  pathRecognizer: string;
  langList: string[];
  useGPU?: boolean;
  timeout?: number;
  magRatio?: number;
  defaultRotationAngles?: number[];
  contrastRetry?: boolean;
  lowConfidenceThreshold?: number;
  recognizerBatchSize?: number;
}

declare interface ONNXOcrArgs {
  opts: Object;
  loader: Loader;
  params: ONNXOcrParams;
}

export interface OCRArgs {
  loader: unknown;
  logger?: unknown;
  params: ONNXOcrParams;
  opts?: {
    stats?: boolean;
  };
}

export interface OCRRunParams {
  path: string;
  options?: {
    paragraph?: boolean;
  };
}

export interface OCRStats {
  detectionTime?: number;
  recognitionTime?: number;
  totalTime?: number;
}

export interface OCRResponse {
  onUpdate: (callback: (data: unknown) => unknown[]) => {
    await: () => Promise<unknown>;
  };
  stats?: OCRStats;
}

export class ONNXOcr extends ONNXBase {
  constructor(args: OCRArgs);

  load(verbose?: boolean): Promise<void>;
  run(params: OCRRunParams): Promise<OCRResponse>;
  unload(): Promise<void>;
}

export const modelClass: typeof ONNXOcr;
export const modelFile: unknown;
