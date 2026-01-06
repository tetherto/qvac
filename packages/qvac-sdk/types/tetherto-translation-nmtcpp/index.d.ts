declare module "@qvac/translation-nmtcpp" {
  export interface TranslationNmtcppConfig {
    modelType?: string;
    beamsize?: number;
    lengthpenalty?: number;
    maxlength?: number;
    repetitionpenalty?: number;
    norepeatngramsize?: number;
    temperature?: number;
    topk?: number;
    topp?: number;
  }

  export interface TranslationNmtcppArgs {
    loader: unknown;
    diskPath: string;
    modelName: string;
    params: {
      srcLang: string;
      dstLang: string;
    };
  }

  export default class TranslationNmtcpp {
    static readonly ModelTypes: {
      readonly IndicTrans: "IndicTrans";
      readonly Opus: "Opus";
    };

    constructor(args: TranslationNmtcppArgs, config: TranslationNmtcppConfig);

    load(verbose?: boolean): Promise<void>;
    translate(input: string): Promise<string>;
    unload(): Promise<void>;
  }
}

declare module "@qvac/translation-nmtcpp/addonLogging" {
  interface AddonLogging {
    setLogger(callback: (priority: number, message: string) => void): void;
    releaseLogger(): void;
  }
  const addonLogging: AddonLogging;
  export default addonLogging;
}
