/// <reference types="node" />

import type ProgressReport from '../src/utils/progressReport';
import type { QvacLogger } from '@qvac/logging';
import type { Loader } from '../index';



/** Result of downloading a single file */
export interface DownloadResult {
  filePath: string | null;
  error: boolean;
  completed: boolean;
}

/** Options for `downloadFiles` */
export interface DownloadOptions {
  /** Whether to close the loader when done (currently unused) */
  closeLoader?: boolean;
  /** Called with the number of bytes downloaded */
  onDownloadProgress?: (bytes: number) => void;
}

/** Event emitted by `streamFiles` for each chunk or when complete */
export interface ChunkEvent {
  filename: string;
  chunk: Buffer | null;
  completed: boolean;
}

/**
 * WeightsProvider handles downloading, streaming, and config retrieval,
 * including progress reporting.
 */
declare class WeightsProvider {
  loader: Loader;
  logger?: QvacLogger;

  /**
   * @param loader  External loader instance
   * @param logger  Optional logger
   */
  constructor(loader: Loader, logger?: Logger);

  /**
   * Initializes a progress report for given files.
   * @param filePaths  Paths to remote files
   * @param callback   Progress callback
   * @returns          A ProgressReport instance or null if skipped
   */
  initProgressReport(
    filePaths: string[],
    callback: (progressData: {
      action: string,
      totalSize: number,
      totalFiles: number,
      filesProcessed: number,
      currentFile: string,
      currentFileProgress: string,
      overallProgress: string
    }) => void
  ): Promise<ProgressReport | null>;

  /**
   * Download weights files to disk with progress.
   * @param fileNames  Remote file names
   * @param diskPath   Local directory to write into
   * @param options    Download options
   * @returns          A map from file name to download result
   */
  downloadFiles(
    fileNames: string[],
    diskPath: string,
    options?: DownloadOptions
  ): Promise<Record<string, DownloadResult>>;

  /**
   * Downloads a single file from the loader to disk
   * @param fileName Name of the file to download
   * @param diskPath Path on disk where file should be saved
   * @param progressReporter Progress reporter instance to track download progress
   * @returns {Promise<void>}
   * @private
   */
  private _downloadFile(
    fileName: string,
    diskPath: string,
    progressReporter: ProgressReport | null
  ): Promise<void>;

  /**
   * @param {string} baseShardFilepath - Path to one of the sharded files, for example `path/SmolLM2-135M-Instruct-IQ3_XS-00001-of-00002.gguf`.
   * @return Returns list of all shards if the file path correspond to a sharded model. It also includes the `*tensors.txt` file.
   */
  static expandGGUFIntoShards(baseShardFilepath: string): string[];

  /**
   * Stream weights to a consumer with progress.
   * @param source      Either a remote path, an existing Readable stream, or an array of the above
   * @param onChunk     Called for each chunk and once when complete
   * @param onProgress  Called with the number of bytes streamed so far
   */
  streamFiles(
    source: string | (NodeJS.ReadableStream & { filename?: string }),
    onChunk: (event: ChunkEvent) => void,
    onProgress?: (bytes: number) => void
  ): Promise<void>;

  /**
   * Retrieve multiple config files as buffers.
   * @param configPaths  Paths to remote config files
   * @returns            A map from path to Buffer
   */
  getConfigs(configPaths: string[]): Promise<Record<string, Buffer>>;
}

export = WeightsProvider;
