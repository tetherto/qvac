import type { QvacResponse } from "@qvac/infer-base";

declare interface ONNXOcrParams {
  pathDetector: string;
  pathRecognizer?: string;
  pathRecognizerPrefix?: string;
  langList?: string[];
  useGPU?: boolean;
  timeout?: number;
  pipelineMode?: 'easyocr' | 'doctr';
  magRatio?: number;
  defaultRotationAngles?: number[];
  contrastRetry?: boolean;
  lowConfidenceThreshold?: number;
  recognizerBatchSize?: number;
  decodingMethod?: 'ctc' | 'attention';
  straightenPages?: boolean;
  graphOptimization?: boolean;
  enableXnnpack?: boolean;
  enableCpuMemArena?: boolean;
  intraOpThreads?: number;
}

export interface OCRArgs {
  params: ONNXOcrParams;
  logger?: unknown;
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

export interface RuntimeStats {
  totalTime: number;
  detectionTime: number;
  recognitionTime: number;
  textRegionsCount: number;
}

export interface InferenceClientState {
  configLoaded: boolean;
  weightsLoaded: boolean;
  destroyed: boolean;
}

export class ONNXOcr {
  constructor(args: OCRArgs);

  getState(): InferenceClientState;
  load(): Promise<void>;
  run(params: OCRRunParams): Promise<QvacResponse>;
  unload(): Promise<void>;
  destroy(): Promise<void>;

  static inferenceManagerConfig: { noAdditionalDownload: boolean };
  static getModelKey(params: ONNXOcrParams): string;
}

export const modelClass: typeof ONNXOcr;
export const modelFile: unknown;
