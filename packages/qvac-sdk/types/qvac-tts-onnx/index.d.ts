declare module "@qvac/tts-onnx" {
  export interface ONNXTTSArgs {
    loader: unknown;
    logger: {
      info: (message: string) => void;
      error: (message: string) => void;
      warn: (message: string) => void;
      debug: (message: string) => void;
      trace: (message: string) => void;
    };
    mainModelUrl: string;
    configJsonPath: string;
    cache: string;
    eSpeakDataPath: string;
    opts: { stats: boolean };
  }

  export interface ONNXTTSConfig {
    language: string;
  }

  export default class ONNXTTS {
    constructor(args: ONNXTTSArgs, config: ONNXTTSConfig);

    load(verbose?: boolean): Promise<void>;
    unload(): Promise<void>;
  }
}

declare module "@qvac/tts-onnx/addonLogging" {
  interface AddonLogging {
    setLogger(callback: (priority: number, message: string) => void): void;
    releaseLogger(): void;
  }
  const addonLogging: AddonLogging;
  export default addonLogging;
}
