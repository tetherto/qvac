import BaseDL from '@qvac/dl-base'
import { QvacErrorBase } from '@qvac/error'

declare class QvacErrorFilesystem extends QvacErrorBase { }

declare interface FilesystemDLOptions {
  dirPath: string
}

declare class FilesystemDL extends BaseDL {
  constructor(opts: FilesystemDLOptions)

  /**
   * Private method to get a readable stream for a given file.
   * @param {string} filePath - The relative path to the file.
   * @returns {Promise<ReadableStream>} The readable stream for the file.
   * @throws {QvacErrorFilesystem} If the file is not found or there's a reading error.
   */
  getStream(filePath: string): Promise<ReadableStream>

  /**
   * List the files in the directory.
   * @param {string} [directoryPath='.'] - The directory to list files from.
   * @returns {Promise<string[]>} Array of file names in the directory.
   * @throws {QvacErrorFilesystem} If the directory is not found or there's a reading error.
   */
  list(directoryPath?: string): Promise<string[]>
}

declare namespace FilesystemDL {
  export { FilesystemDL as default, FilesystemDLOptions }
}

export = FilesystemDL
