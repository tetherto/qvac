declare interface ErrorDefinition {
  name: string
  message: string | ((...args: any[]) => string)
}

declare interface ErrorCodesMap {
  [code: number]: ErrorDefinition
}

declare interface QvacErrorOptions {
  code?: number
  adds?: any[] | string
  cause?: Error
}

declare class QvacErrorBase extends Error {
  code: number
  name: string
  message: string
  cause?: Error

  constructor(options?: QvacErrorOptions)
  toJSON(): {
    name: string
    code: number
    message: string
    stack?: string
    cause?: Error
  }
}

declare const INTERNAL_ERROR_CODES: {
  readonly UNKNOWN_ERROR_CODE: 0
  readonly INVALID_CODE_DEFINITION: 1
  readonly ERROR_CODE_ALREADY_EXISTS: 2
  readonly MISSING_ERROR_DEFINITION: 3
}

declare function addCodes(codes: ErrorCodesMap): void
declare function getRegisteredCodes(): ErrorCodesMap
declare function isCodeRegistered(code: number): boolean

export {
  QvacErrorBase,
  addCodes,
  getRegisteredCodes,
  isCodeRegistered,
  INTERNAL_ERROR_CODES,
  ErrorDefinition,
  ErrorCodesMap,
  QvacErrorOptions
}

export default QvacErrorBase
