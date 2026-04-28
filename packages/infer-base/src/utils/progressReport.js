'use strict'

class ProgressReport {
  /**
   * Initializes a new instance of ProgressReport.
   * @param {Object} filesizeMapping - Mapping between filename and total size.
   * @param {Function} progressCallback - Optional callback function to report progress.
   */
  constructor (filesizeMapping, progressCallback = null) {
    this.filesizeMapping = filesizeMapping
    this.progressCallback = progressCallback

    this.totalSize = Object.values(filesizeMapping).reduce((sum, size) => sum + size, 0)
    this.totalFiles = Object.keys(filesizeMapping).length

    this.downloadedSizeMapping = {}

    this.overallDownloaded = 0
    this.overallProgress = '0.00'
    this.filesProcessed = 0
  }

  /**
   * Updates the progress with the number of bytes downloaded for a specific file.
   * @param {string} filename - Name of the file being downloaded.
   * @param {number} bytes - Number of bytes downloaded in the current chunk.
   */
  update (filename, bytes) {
    if (!this.downloadedSizeMapping[filename]) {
      this.downloadedSizeMapping[filename] = 0
    }
    this.downloadedSizeMapping[filename] += bytes

    this.overallDownloaded += bytes

    this.overallProgress = this._calculateProgress(this.overallDownloaded, this.totalSize)

    const currentFileDownloaded = this.downloadedSizeMapping[filename]
    const currentFileSize = this.filesizeMapping[filename]
    const currentFileProgress = this._calculateProgress(currentFileDownloaded, currentFileSize)

    this._reportProgress('loadingFile', filename, currentFileProgress)
  }

  /**
   * Marks the file as completed.
   * @param {string} filename - Name of the file that has been fully downloaded.
   */
  completeFile (filename) {
    const fileSize = this.filesizeMapping[filename]
    const downloadedSize = this.downloadedSizeMapping[filename] || 0
    const remainingBytes = fileSize - downloadedSize

    if (remainingBytes > 0) {
      this.overallDownloaded += remainingBytes
      this.downloadedSizeMapping[filename] = fileSize
    }

    this.overallProgress = this._calculateProgress(this.overallDownloaded, this.totalSize)

    this.filesProcessed += 1

    this._reportProgress('completeFile', filename, '100.00')
  }

  /**
   * Internal method to calculate progress percentages.
   * @param {number} downloaded - Number of bytes downloaded.
   * @param {number} total - Total number of bytes.
   * @returns {string} Progress percentage formatted to two decimal places.
   */
  _calculateProgress (downloaded, total) {
    return total ? ((downloaded / total) * 100).toFixed(2) : '0.00'
  }

  /**
   * Internal method to invoke the progress callback with current progress data.
   * @param {string} action - Action that triggered the progress report.
   * @param {string} filename - Name of the file being reported.
   * @param {string} currentFileProgress - Progress percentage of the current file.
   */
  _reportProgress (action, filename, currentFileProgress) {
    if (this.progressCallback) {
      const progressData = {
        action,
        totalSize: this.totalSize,
        totalFiles: this.totalFiles,
        filesProcessed: this.filesProcessed,
        currentFile: filename,
        currentFileProgress,
        overallProgress: this.overallProgress
      }

      this.progressCallback(progressData)
    }
  }
}

module.exports = ProgressReport
