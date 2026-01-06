declare module "@qvac/embed-llamacpp" {
  export interface EmbedArgs {
    modelPath: string;
    loader: unknown;
    opts: { stats: boolean };
    logger: {
      info: (message: string) => void;
      error: (message: string) => void;
      warn: (message: string) => void;
      debug: (message: string) => void;
      trace: (message: string) => void;
    };
    diskPath: string;
    modelName: string;
  }

  export interface EmbedResponse {
    await(): Promise<Float32Array[][]>;
  }

  export default class EmbedLlamacpp {
    constructor(args: EmbedArgs, config: string);

    load(verbose?: boolean): Promise<void>;
    embed(input: string | string[]): Promise<EmbedResponse>;
    unload(): Promise<void>;
  }
}

declare module "@qvac/embed-llamacpp/addonLogging" {
  interface AddonLogging {
    setLogger(callback: (priority: number, message: string) => void): void;
    releaseLogger(): void;
  }
  const addonLogging: AddonLogging;
  export default addonLogging;
}
