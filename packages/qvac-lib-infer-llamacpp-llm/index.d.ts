/// <reference types="node" />

import BaseInference from '@qvac/infer-base/WeightsProvider/BaseInference';
import WeightsProvider from '@qvac/infer-base/WeightsProvider/WeightsProvider';
import type { QvacResponse } from '@qvac/infer-base';
import type Logger  from '@qvac/logging';
import type Loader  from '@qvac/dl-base';
import type { Readable } from 'stream';

/**
 * Loader interface provides the methods required by LlmLlamacpp to fetch and manage streams.
 */
export interface Loader {
  /** Prepare the loader for operations */
  ready(): Promise<void>;
  /** Clean up or close any underlying resources */
  close(): Promise<void>;
  /** Obtain a readable stream for the specified path */
  getStream(path: string): Promise<Readable>;
  /** (Optional) Retrieve the size of a remote file in bytes */
  getFileSize?(path: string): Promise<number>;
}

/**
 * Arguments required to construct an instance of LlmLlamacpp
 */
export interface LlmLlamacppArgs {
  /** External loader instance */
  loader: Loader;
  /** Optional structured logger */
  logger?: Logger;
  /** Optional inference options */
  opts?: Record<string, any>;
  /** Disk directory where model files are stored */
  diskPath: string;
  /** Name of the model directory or file */
  modelName: string;
  /** Name of the projection model directory or file */
  projectionModel?: string;
}

/** Literal indicating end-of-input for the LLM job */
export type EndOfInput = 'end of job';

/** Input types accepted by the Llama addon */
export type AppendInput =
  | { type: 'text'; input: string }
  | { type: 'media'; input: Uint8Array }
  | { type: EndOfInput };

/** Minimal interface for the native addon controlling the LLM */
export interface Addon {
  activate(): Promise<void>;
  append(input: AppendInput): Promise<number>;
  cancel(jobId: number): Promise<void>;
}

/** Callback invoked with the number of bytes processed during downloads */
export type ProgressReportCallback = (bytes: number) => void;


/** Structure of a message for chat-style prompts */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool' | string;
  content: string;
}

/**
 * GGML client implementation for the Llama LLM model.
 */
declare class LlmLlamacpp extends BaseInference {
  protected readonly _config: Record<string, any>;
  protected readonly _diskPath: string;
  protected readonly _modelName: string;
  protected addon!: Addon;
  protected weightsProvider: WeightsProvider;

  /**
   * @param args - Setup parameters including loader, logger, disk path, and model name
   * @param config - Model-specific configuration settings
   */
  constructor(args: LlmLlamacppArgs, config: Record<string, any>);

  /**
   * Implementation of load method, to load model weights, initialize the native addon, and activate the model.
   * @param closeLoader - Whether to close the loader when complete (default true)
   * @param onDownloadProgress - Optional byte-level progress callback
   */
  protected _load(
    closeLoader?: boolean,
    onDownloadProgress?: ProgressReportCallback
  ): Promise<void>;

  /**
   * Load model weights, initialize the native addon, and activate the model.
   * @param closeLoader - Whether to close the loader when complete (default true)
   * @param onDownloadProgress - Optional byte-level progress callback
   */
  public load(
    closeLoader?: boolean,
    onDownloadProgress?: ProgressReportCallback
  ): Promise<void>;

  /**
   * Download the model weight files and return the local path to the primary file.
   * @param onDownloadProgress - Callback invoked with bytes downloaded
   * @returns Local file path for the model weights
   */
  public downloadWeights(
    onDownloadProgress?: ProgressReportCallback,
    opts?: {
      closeLoader?: boolean
    }
  ): Promise<string>;

  /**
   * Instantiate the native addon with the given parameters.
   * @param params.path - Local file or directory path
   * @param params.settings - LLM-specific settings
   */
  protected _createAddon(
    params: { path: string; settings: Record<string, any> }
  ): Addon;

  /**
   * Internal method to start inference with a text prompt.
   * @param prompt - Input prompt string
   * @returns A QvacResponse representing the inference job
   */
  protected _runInternal(prompt: Message[]): Promise<QvacResponse>;

  /**
   * Public API to run inference. Delegates to _runInternal.
   * @param prompt - Input prompt string
   */
  run(prompt: Message[]): Promise<QvacResponse>;
}

export = LlmLlamacpp;
