import {
  ERR_CODES,
  QvacErrorAddonTTSGgml,
} from "./lib/error";

export interface TTSConfigurationParams {
  [key: string]: string | number | boolean | undefined;
}

export interface TTSJobData {
  type: string;
  input: string;
}

export interface TTSWeightData {
  filename: string;
  chunk: Uint8Array;
  completed: boolean;
}

export type TTSOutputCallback = (
  addon: unknown,
  event: unknown,
  data: unknown,
  error: unknown,
) => void;

export interface TTSBinding {
  createInstance(
    owner: TTSInterface,
    configuration: TTSConfigurationParams,
    outputCallback: TTSOutputCallback | null,
  ): object;
  activate(handle: object | null): Promise<void>;
  runJob(handle: object | null, data: TTSJobData): void;
  loadWeights(
    handle: object | null,
    weightsData: TTSWeightData,
  ): void;
  cancel(handle: object | null): Promise<void>;
  destroyInstance(handle: object): Promise<void> | void;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

function errorCause(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error));
}

/** An interface between the Bare addon in C++ and the JS runtime. */
export class TTSInterface {
  private readonly _binding: TTSBinding;
  private _handle: object | null;

  constructor(
    binding: TTSBinding,
    configuration: TTSConfigurationParams = {},
    outputCallback: TTSOutputCallback | null = null,
  ) {
    this._binding = binding;
    this._handle = this._binding.createInstance(
      this,
      configuration,
      outputCallback,
    );
  }

  async activate(): Promise<void> {
    try {
      await this._binding.activate(this._handle);
    } catch (error) {
      throw new QvacErrorAddonTTSGgml({
        code: ERR_CODES.FAILED_TO_ACTIVATE,
        adds: errorMessage(error),
        cause: errorCause(error),
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- preserves the established promise-returning wrapper API.
  async runJob(data: TTSJobData): Promise<void> {
    try {
      this._binding.runJob(this._handle, data);
    } catch (error) {
      throw new QvacErrorAddonTTSGgml({
        code: ERR_CODES.FAILED_TO_APPEND,
        adds: errorMessage(error),
        cause: errorCause(error),
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- preserves the established promise-returning wrapper API.
  async loadWeights(weightsData: TTSWeightData): Promise<void> {
    try {
      this._binding.loadWeights(this._handle, weightsData);
    } catch (error) {
      throw new QvacErrorAddonTTSGgml({
        code: ERR_CODES.FAILED_TO_LOAD,
        adds: errorMessage(error),
        cause: errorCause(error),
      });
    }
  }

  async cancel(): Promise<void> {
    try {
      await this._binding.cancel(this._handle);
    } catch (error) {
      throw new QvacErrorAddonTTSGgml({
        code: ERR_CODES.FAILED_TO_CANCEL,
        adds: errorMessage(error),
        cause: errorCause(error),
      });
    }
  }

  async destroyInstance(): Promise<void> {
    if (this._handle === null) return;
    try {
      const handle = this._handle;
      this._handle = null;
      await this._binding.destroyInstance(handle);
    } catch (error) {
      throw new QvacErrorAddonTTSGgml({
        code: ERR_CODES.FAILED_TO_DESTROY,
        adds: errorMessage(error),
        cause: errorCause(error),
      });
    }
  }

  async unload(): Promise<void> {
    return this.destroyInstance();
  }
}
