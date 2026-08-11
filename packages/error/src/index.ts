export interface ErrorDefinition {
  name: string
  message: string | ((...args: any[]) => string)
}

export type ErrorCodesMap = Record<number, ErrorDefinition>

export interface QvacErrorOptions {
  code?: number | undefined
  adds?: any[] | string | undefined
  cause?: Error | undefined
}

export interface SerializedError {
  name: string
  code: number
  message: string
  stack?: string | undefined
  cause?: Error | undefined
}

export interface PackageInfo {
  // Package name (e.g., '@tetherto/inference-addon-mlc-base')
  name: string
  // Package version (semantic version)
  version: string
}

interface PackageRegistryEntry {
  version: string
  codes: number[]
}

// Reserved internal error codes.
const ERR_CODES = Object.freeze({
  // Internal error codes (0-999)
  UNKNOWN_ERROR_CODE: 0,
  INVALID_CODE_DEFINITION: 1,
  ERROR_CODE_ALREADY_EXISTS: 2,
  MISSING_ERROR_DEFINITION: 3,
  PACKAGE_VERSION_CONFLICT: 4,
  INVALID_PACKAGE_INFO: 5
} as const)

// Fallback definition used when a requested code is not registered.
const UNKNOWN_ERROR = {
  name: 'UNKNOWN_ERROR_CODE',
  message: (code: number) => `Unknown QVAC error code: ${code}`
}

// Map of error codes to their content (name and message).
const codeToContent: ErrorCodesMap = {
  [ERR_CODES.UNKNOWN_ERROR_CODE]: UNKNOWN_ERROR,
  [ERR_CODES.INVALID_CODE_DEFINITION]: {
    name: 'INVALID_CODE_DEFINITION',
    message: (code) => `Invalid definition for error code: ${code}`
  },
  [ERR_CODES.ERROR_CODE_ALREADY_EXISTS]: {
    name: 'ERROR_CODE_ALREADY_EXISTS',
    message: (code) => `Error code already exists: ${code}`
  },
  [ERR_CODES.MISSING_ERROR_DEFINITION]: {
    name: 'MISSING_ERROR_DEFINITION',
    message: (code) => `Missing name or message for error code: ${code}`
  },
  [ERR_CODES.PACKAGE_VERSION_CONFLICT]: {
    name: 'PACKAGE_VERSION_CONFLICT',
    message: (pkg, existingVer, newVer) =>
      `Package ${pkg} version conflict: existing ${existingVer}, attempted ${newVer}`
  },
  [ERR_CODES.INVALID_PACKAGE_INFO]: {
    name: 'INVALID_PACKAGE_INFO',
    message: () => 'Package name and version are required for registration'
  }
}

// Registry of packages and their registered code ranges.
const packageRegistry = new Map<string, PackageRegistryEntry>()

// Compares two semantic version strings; -1 if v1 < v2, 0 if equal, 1 if v1 > v2.
function compareVersions(version1: string, version2: string): number {
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

// Base class for all QVAC errors. Extends the standard Error class with
// QVAC-specific functionality.
export class QvacErrorBase extends Error {
  code: number
  override name: string
  override cause: Error | undefined

  constructor(options: QvacErrorOptions = {}) {
    const { code, adds, cause } = options
    let msgContent = ''
    let errorCode: number = ERR_CODES.UNKNOWN_ERROR_CODE
    let errorName = new.target.name

    const codeObj = code !== undefined ? codeToContent[code] : undefined

    if (code === undefined) {
      msgContent = 'Unknown QVAC error'
      errorCode = ERR_CODES.UNKNOWN_ERROR_CODE
      errorName = new.target.name
    } else if (!codeObj) {
      msgContent = UNKNOWN_ERROR.message(code)
      errorCode = ERR_CODES.UNKNOWN_ERROR_CODE
      errorName = UNKNOWN_ERROR.name
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

    const captureStackTrace = (
      Error as { captureStackTrace?: (target: object, ctor?: unknown) => void }
    ).captureStackTrace
    if (typeof captureStackTrace === 'function') {
      captureStackTrace(this, this.constructor)
    }
    if (cause?.stack) {
      this.stack = `${this.stack ?? ''}\n\nCaused by: ${cause.stack}`
    }
  }

  // Serializes the error to a plain object.
  toJSON(): SerializedError {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      stack: this.stack,
      cause: this.cause
    }
  }
}

// Registers new error codes with optional package information for collision
// avoidance. Throws QvacErrorBase on conflicts or invalid definitions.
export function addCodes(codes: ErrorCodesMap, packageInfo?: PackageInfo): void {
  // If no package info provided, use legacy behavior
  if (!packageInfo) {
    for (const [code, def] of Object.entries(codes)) {
      const numericCode = Number(code)

      if (codeToContent[numericCode]) {
        throw new QvacErrorBase({ code: ERR_CODES.ERROR_CODE_ALREADY_EXISTS, adds: [numericCode] })
      }

      if (!def || typeof def !== 'object') {
        throw new QvacErrorBase({ code: ERR_CODES.INVALID_CODE_DEFINITION, adds: [numericCode] })
      }

      if (!def.name || !def.message) {
        throw new QvacErrorBase({ code: ERR_CODES.MISSING_ERROR_DEFINITION, adds: [numericCode] })
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
  const registeredCodes: number[] = []

  for (const [code, def] of Object.entries(codes)) {
    const numericCode = Number(code)

    // Check if code is already registered by another package
    if (
      codeToContent[numericCode] &&
      (!existingPackage || !existingPackage.codes.includes(numericCode))
    ) {
      throw new QvacErrorBase({ code: ERR_CODES.ERROR_CODE_ALREADY_EXISTS, adds: [numericCode] })
    }

    if (!def || typeof def !== 'object') {
      throw new QvacErrorBase({ code: ERR_CODES.INVALID_CODE_DEFINITION, adds: [numericCode] })
    }

    if (!def.name || !def.message) {
      throw new QvacErrorBase({ code: ERR_CODES.MISSING_ERROR_DEFINITION, adds: [numericCode] })
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

// Gets all registered error codes and their definitions.
export function getRegisteredCodes(): ErrorCodesMap {
  return JSON.parse(JSON.stringify(codeToContent))
}

// Checks if a code is already registered.
export function isCodeRegistered(code: number): boolean {
  return !!codeToContent[code]
}

export { ERR_CODES as INTERNAL_ERROR_CODES }

export default QvacErrorBase
