/// <reference types="node" />

import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import Hyperswarm from 'hyperswarm'
import HyperdriveProgressTracker from './src/HyperdriveProgressTracker'
import BaseDL from '@qvac/dl-base'

export interface HyperDriveOptions {
  key?: string
  drive?: Hyperdrive
  prefix?: string
  version?: number
  store?: Corestore
  swarm?: Hyperswarm
}

export interface HyperDriveDownloadResult {
  file: string
  error: any | null
  cached: boolean
}

export interface HyperDriveDownload {
  trackers: HyperdriveProgressTracker[]
  await: () => Promise<HyperDriveDownloadResult[]>
  cancel: () => Promise<void>
}

export class HyperDriveDL extends BaseDL {
  /**
   * Create a new HyperDriveDL instance.
   * @param {HyperDriveOptions} opts - Options for the Hyperdrive downloader.
   * @throws {QvacErrorHyperdrive} If opts is not an object, doesn't contain a key, or if the key is invalid.
   */
  constructor(opts: HyperDriveOptions)

  /**
   * Initializes the Hyperdrive client.
   * After initialization data loader guarantees to have the latest known snapshot of available file records.
   * @returns {Promise<void>}
   * @throws {QvacErrorHyperdrive} If connection or initialization fails.
   */
  ready(): Promise<void>

  /**
   * Stops the Hyperdrive client.
   * @returns {Promise<void>}
   */
  close(): Promise<void>

  /**
   * Get a file as async iterable buffer stream.
   * @param {string} path - The file path inside the Hyperdrive.
   * @param {Object} [opts] - Optional parameters.
   * @returns {Promise<AsyncIterable<Buffer>>} The file content as async iterable.
   * @throws {QvacErrorHyperdrive} If the file is not found or the drive is not ready.
   */
  getStream(path: string, opts?: Object): Promise<AsyncIterable<Buffer>>

  /**
   * Get the size of a file in bytes.
   * @param {string} path - The file path inside the Hyperdrive.
   * @param {Object} [opts] - Optional parameters.
   * @returns {Promise<number>} The size of the file in bytes.
   * @throws {QvacErrorHyperdrive} If the file is not found or the drive is not ready.
   */
  getFileSize(path: string, opts?: Object): Promise<number>

  /**
   * Check if all files in a given directory are cached.
   * @param {string} [path='/'] - The directory or file path to check.
   * @returns {Promise<boolean>} True if all files are cached, false otherwise.
   * @throws {QvacErrorHyperdrive} If the check fails or the drive is not ready.
   */
  cached(path?: string): Promise<boolean>

  /**
   * Lists the files in a given directory in the Hyperdrive.
   * @param {string} [directoryPath='/'] - The directory to list files from. Defaults to '/'.
   * @param {Object} [opts] - Optional parameters.
   * @returns {Promise<Array<{key: string, cached?: boolean}>>} A list of files with their keys and cache status.
   * @throws {QvacErrorHyperdrive} If listing fails or the drive is not ready.
   */
  list(directoryPath?: string, opts?: Object): Promise<{key: string, cached?: boolean}[]>

  /**
   * Downloads file to local drive cache based on supplied path.
   * Can optionally save files directly to disk using the diskPath option.
   * @param path - The path to download the file from.
   * @param opts - Options object or legacy ProgressReport instance.
   * @param opts.diskPath - Path to save files to disk instead of cache.
   * @param opts.progressReporter - Progress reporter instance.
   * @param opts.progressCallback - Progress callback function, will initialize a progress report internally if provided.
   * @returns Download object with trackers, await function that returns download results, and cancel function.
   */
  download(path?: string, opts?: Object): Promise<HyperDriveDownload>

  /**
   * Deletes weights if present on local storage.
   * Returns true if deleted and false if no weights found
   * @param {string} path - The path to delete the file from.
   * @param {Object} [opts] - Optional parameters.
   * @returns {Promise<boolean>} True if deleted, false if no file found.
   * @throws {QvacErrorHyperdrive} If deletion fails or the drive is not ready.
   */
  deleteLocal(path?: string, opts?: Object): Promise<boolean>
}
export default HyperDriveDL
export { HyperDriveOptions }


