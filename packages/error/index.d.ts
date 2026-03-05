declare namespace _exports {
    export { ErrorDefinition, ErrorCodesMap, QvacErrorOptions, SerializedError, PackageInfo };
}
declare namespace _exports {
    export { QvacErrorBase };
    export { addCodes };
    export { getRegisteredCodes };
    export { isCodeRegistered };
    export { ERR_CODES as INTERNAL_ERROR_CODES };
    export { QvacErrorBase as default };
}
export = _exports;
type ErrorDefinition = {
    /**
     * - Error name identifier
     */
    name: string;
    /**
     * - Error message or message factory
     */
    message: string | ((...args: any[]) => string);
};
type ErrorCodesMap = {
    [code: number]: ErrorDefinition;
};
type QvacErrorOptions = {
    /**
     * - The error code
     */
    code?: number | undefined;
    /**
     * - Additional arguments to format the message
     */
    adds?: string | any[] | undefined;
    /**
     * - The original error that caused this one
     */
    cause?: Error | undefined;
};
type SerializedError = {
    name: string;
    code: number;
    message: string;
    stack?: string | undefined;
    cause?: Error | undefined;
};
type PackageInfo = {
    /**
     * - Package name (e.g., '@tetherto/qvac-lib-inference-addon-mlc-base')
     */
    name: string;
    /**
     * - Package version (semantic version)
     */
    version: string;
};
/**
 * Base class for all QVAC errors
 * Extends the standard Error class with QVAC-specific functionality
 */
declare class QvacErrorBase extends Error {
    /**
     * Creates a new QVAC error
     * @param {QvacErrorOptions} [options] - Error options
     */
    constructor(options?: QvacErrorOptions);
    /** @type {number} */
    code: number;
    /** @type {Error | undefined} */
    cause: Error | undefined;
    /**
     * Serializes the error to a plain object
     * @returns {SerializedError}
     */
    toJSON(): SerializedError;
}
/**
 * Registers new error codes with optional package information for collision avoidance
 * @param {ErrorCodesMap} codes - Map of error codes to their definitions
 * @param {PackageInfo} [packageInfo] - Optional package information for collision management
 * @throws {QvacErrorBase} If there are conflicts or invalid definitions
 */
declare function addCodes(codes: ErrorCodesMap, packageInfo?: PackageInfo): void;
/**
 * Gets all registered error codes and their definitions
 * @returns {ErrorCodesMap}
 */
declare function getRegisteredCodes(): ErrorCodesMap;
/**
 * Checks if a code is already registered
 * @param {number} code - The error code to check
 * @returns {boolean} True if the code is already registered
 */
declare function isCodeRegistered(code: number): boolean;
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
declare const ERR_CODES: Readonly<{
    UNKNOWN_ERROR_CODE: 0;
    INVALID_CODE_DEFINITION: 1;
    ERROR_CODE_ALREADY_EXISTS: 2;
    MISSING_ERROR_DEFINITION: 3;
    PACKAGE_VERSION_CONFLICT: 4;
    INVALID_PACKAGE_INFO: 5;
}>;
