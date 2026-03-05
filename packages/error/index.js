'use strict'

/**
 * @typedef {Object} ErrorDefinition
 * @property {string} name - Error name identifier
 * @property {string | ((...args: any[]) => string)} message - Error message or message factory
 */

/**
 * @typedef {{ [code: number]: ErrorDefinition }} ErrorCodesMap
 */

/**
 * @typedef {Object} QvacErrorOptions
 * @property {number} [code] - The error code
 * @property {any[] | string} [adds] - Additional arguments to format the message
 * @property {Error} [cause] - The original error that caused this one
 */

/**
 * @typedef {Object} SerializedError
 * @property {string} name
 * @property {number} code
 * @property {string} message
 * @property {string} [stack]
 * @property {Error} [cause]
 */

/**
 * @typedef {Object} PackageInfo
 * @property {string} name - Package name (e.g., '@tetherto/qvac-lib-inference-addon-mlc-base')
 * @property {string} version - Package version (semantic version)
 */

/**
 * Reserved internal error codes
 * @private
 */
const ERR_CODES = Object.freeze({
  // Internal error codes (0-999)
  UNKNOWN_ERROR_CODE: 0,
  INVALID_CODE_DEFINITION: 1,
  ERROR_CODE_ALREADY_EXISTS: 2,
  MISSING_ERROR_DEFINITION: 3,
  PACKAGE_VERSION_CONFLICT: 4,
  INVALID_PACKAGE_INFO: 5
})

/**
 * Map of error codes to their content (name and message)
 * @private
 */
const codeToContent = {
  [ERR_CODES.UNKNOWN_ERROR_CODE]: {
    name: 'UNKNOWN_ERROR_CODE',
    message: code => `Unknown QVAC error code: ${code}`
  },
  [ERR_CODES.INVALID_CODE_DEFINITION]: {
    name: 'INVALID_CODE_DEFINITION',
    message: code => `Invalid definition for error code: ${code}`
  },
  [ERR_CODES.ERROR_CODE_ALREADY_EXISTS]: {
    name: 'ERROR_CODE_ALREADY_EXISTS',
    message: code => `Error code already exists: ${code}`
  },
  [ERR_CODES.MISSING_ERROR_DEFINITION]: {
    name: 'MISSING_ERROR_DEFINITION',
    message: code => `Missing name or message for error code: ${code}`
  },
  [ERR_CODES.PACKAGE_VERSION_CONFLICT]: {
    name: 'PACKAGE_VERSION_CONFLICT',
    message: (pkg, existingVer, newVer) => `Package ${pkg} version conflict: existing ${existingVer}, attempted ${newVer}`
  },
  [ERR_CODES.INVALID_PACKAGE_INFO]: {
    name: 'INVALID_PACKAGE_INFO',
    message: () => 'Package name and version are required for registration'
  }
}

/**
 * Registry of packages and their registered code ranges
 * @private
 */
const packageRegistry = new Map()

/**
 * Compares two semantic version strings
 * @param {string} version1
 * @param {string} version2
 * @returns {number} -1 if v1 < v2, 0 if equal, 1 if v1 > v2
 */
function compareVersions (version1, version2) {
  const v1Parts = version1.split('.').map(Number)
  const v2Parts = version2.split('.').map(Number)

  const maxLength = Math.max(v1Parts.length, v2Parts.length)

  for (let i = 0; i < maxLength; i++) {
    const v1Part = v1Parts[i] || 0
    const v2Part = v2Parts[i] || 0

    if (v1Part < v2Part) return -1
    if (v1Part > v2Part) return 1
  }

  return 0
}

/**
 * Base class for all QVAC errors
 * Extends the standard Error class with QVAC-specific functionality
 */
class QvacErrorBase extends Error {
  /** @type {number} */
  code
  /** @type {string} */
  name
  /** @type {Error | undefined} */
  cause

  /**
   * Creates a new QVAC error
   * @param {QvacErrorOptions} [options] - Error options
   */
  constructor (options = {}) {
    const { code, adds, cause } = options
    let msgContent = ''
    /** @type {number} */
    let errorCode = ERR_CODES.UNKNOWN_ERROR_CODE
    /** @type {string} */
    let errorName = new.target.name

    const unknownError = codeToContent[ERR_CODES.UNKNOWN_ERROR_CODE]
    const codeObj = code !== undefined ? codeToContent[code] : undefined

    if (code === undefined) {
      msgContent = 'Unknown QVAC error'
      errorCode = ERR_CODES.UNKNOWN_ERROR_CODE
      errorName = new.target.name
    } else if (!codeObj) {
      msgContent = unknownError.message(code)
      errorCode = ERR_CODES.UNKNOWN_ERROR_CODE
      errorName = unknownError.name
    } else {
      if (typeof codeObj.message === 'function') {
        msgContent = codeObj.message(...(Array.isArray(adds) ? adds : [adds]))
      } else if (typeof codeObj.message === 'string') {
        msgContent = codeObj.message + (adds ? ` ${adds}` : '')
      }
      errorCode = code
      errorName = codeObj.name
    }

    super(msgContent, cause !== undefined ? { cause } : undefined)
    this.code = errorCode
    this.name = errorName
    this.cause = cause

    Object.setPrototypeOf(this, new.target.prototype)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor)
    }
    if (cause && cause.stack) {
      this.stack += '\n\nCaused by: ' + cause.stack
    }
  }

  /**
   * Serializes the error to a plain object
   * @returns {SerializedError}
   */
  toJSON () {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      stack: this.stack,
      cause: this.cause
    }
  }
}

/**
 * Registers new error codes with optional package information for collision avoidance
 * @param {ErrorCodesMap} codes - Map of error codes to their definitions
 * @param {PackageInfo} [packageInfo] - Optional package information for collision management
 * @throws {QvacErrorBase} If there are conflicts or invalid definitions
 */
function addCodes (codes, packageInfo) {
  // If no package info provided, use legacy behavior
  if (!packageInfo) {
    for (const [code, def] of Object.entries(codes)) {
      const numericCode = Number(code)

      if (codeToContent[numericCode]) {
        throw new QvacErrorBase({ code: ERR_CODES.ERROR_CODE_ALREADY_EXISTS, adds: numericCode })
      }

      if (!def || typeof def !== 'object') {
        throw new QvacErrorBase({ code: ERR_CODES.INVALID_CODE_DEFINITION, adds: numericCode })
      }

      if (!def.name || !def.message) {
        throw new QvacErrorBase({ code: ERR_CODES.MISSING_ERROR_DEFINITION, adds: numericCode })
      }

      codeToContent[numericCode] = {
        name: def.name,
        message: def.message
      }
    }

    return
  }

  if (!packageInfo.name || !packageInfo.version) {
    throw new QvacErrorBase({ code: ERR_CODES.INVALID_PACKAGE_INFO })
  }

  const { name: packageName, version: packageVersion } = packageInfo
  const existingPackage = packageRegistry.get(packageName)

  // Check if package is already registered
  if (existingPackage) {
    const versionComparison = compareVersions(packageVersion, existingPackage.version)

    if (versionComparison > 0) {
      // Newer version - remove old codes first
      for (const code of existingPackage.codes) {
        delete codeToContent[code]
      }
    } else {
      return
    }
  }

  // Validate and register new codes
  const registeredCodes = []

  for (const [code, def] of Object.entries(codes)) {
    const numericCode = Number(code)

    // Check if code is already registered by another package
    if (codeToContent[numericCode] && (!existingPackage || !existingPackage.codes.includes(numericCode))) {
      throw new QvacErrorBase({ code: ERR_CODES.ERROR_CODE_ALREADY_EXISTS, adds: numericCode })
    }

    if (!def || typeof def !== 'object') {
      throw new QvacErrorBase({ code: ERR_CODES.INVALID_CODE_DEFINITION, adds: numericCode })
    }

    if (!def.name || !def.message) {
      throw new QvacErrorBase({ code: ERR_CODES.MISSING_ERROR_DEFINITION, adds: numericCode })
    }

    codeToContent[numericCode] = {
      name: def.name,
      message: def.message
    }

    registeredCodes.push(numericCode)
  }

  // Update package registry
  packageRegistry.set(packageName, {
    version: packageVersion,
    codes: registeredCodes
  })
}

/**
 * Gets all registered error codes and their definitions
 * @returns {ErrorCodesMap}
 */
function getRegisteredCodes () {
  return JSON.parse(JSON.stringify(codeToContent))
}

/**
 * Checks if a code is already registered
 * @param {number} code - The error code to check
 * @returns {boolean} True if the code is already registered
 */
function isCodeRegistered (code) {
  return !!codeToContent[code]
}

module.exports = {
  QvacErrorBase,
  addCodes,
  getRegisteredCodes,
  isCodeRegistered,
  INTERNAL_ERROR_CODES: ERR_CODES
}

module.exports.default = QvacErrorBase
