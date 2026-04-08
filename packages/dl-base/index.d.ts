/**
 * Base class for dataloaders
 * @class BaseDL
 */
export = class BaseDL {

  /**
   * Creates an instance of BaseDL.
   * @constructor
   * @param {Object} opts Options for the dataloader
   */
  constructor(opts: Object)

  /**
   * Start the dataloader
   * @returns {Promise<void>}
   */
  ready(): Promise<void>

  /**
   * Start the dataloader (INTERNAL METHOD)
   * @returns {Promise<void>}
   */
  _open(): Promise<void>

  /**
   * Stop the dataloader
   * @returns {Promise<void>}
   */
  close(): Promise<void>

  /**
   * Stop the dataloader (INTERNAL METHOD)
   * @returns {Promise<void>}
   */
  _close(): Promise<void>

  /**
   * List files in a directory
   * @param {string} [path='.'] Path to list
   * @returns {Promise<Array<any>>} List of files
   */
  list(path?: string): Promise<Array<any>>

  /**
   * Get a file as async iterable buffer stream
   * @param {string} path Path to the file
   * @returns {Promise<AsyncIterable<Buffer>>} File content
   */
  getStream(path: string): Promise<AsyncIterable<Buffer>>
}
