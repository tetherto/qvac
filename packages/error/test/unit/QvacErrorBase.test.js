'use strict'

const test = require('brittle')
const {
  QvacErrorBase,
  addCodes,
  getRegisteredCodes,
  isCodeRegistered,
  INTERNAL_ERROR_CODES
} = require('../..')

test('QvacErrorBase should handle basic error creation', t => {
  // Define a test error code
  const TEST_CODE = 1000
  addCodes({
    [TEST_CODE]: {
      name: 'TEST_ERROR',
      message: 'This is a test error'
    }
  })

  const error = new QvacErrorBase({ code: TEST_CODE })
  t.is(error.code, TEST_CODE, 'Error has the correct code')
  t.is(error.name, 'TEST_ERROR', 'Error has the correct name')
  t.is(error.message, 'This is a test error', 'Error has the correct message')
  t.ok(error instanceof Error, 'Error is an instance of Error')
  t.ok(error instanceof QvacErrorBase, 'Error is an instance of QvacErrorBase')
})

test('QvacErrorBase should handle unknown error codes', t => {
  const UNKNOWN_CODE = 999999
  const error = new QvacErrorBase({ code: UNKNOWN_CODE })

  t.is(error.code, INTERNAL_ERROR_CODES.UNKNOWN_ERROR_CODE, 'Error has the unknown error code')
  t.is(error.name, 'UNKNOWN_ERROR_CODE', 'Error has the unknown error name')
  t.ok(error.message.includes(UNKNOWN_CODE.toString()), 'Error message includes the unknown code')
})

test('QvacErrorBase should handle function-based messages', t => {
  const FUNC_CODE = 1001
  addCodes({
    [FUNC_CODE]: {
      name: 'FUNCTION_ERROR',
      message: (param1, param2) => `Error with ${param1} and ${param2}`
    }
  })

  const error = new QvacErrorBase({ code: FUNC_CODE, adds: ['value1', 'value2'] })
  t.is(error.message, 'Error with value1 and value2', 'Error formats message with parameters')

  // Test with single parameter that isn't an array
  const singleError = new QvacErrorBase({ code: FUNC_CODE, adds: 'value' })
  t.is(singleError.message, 'Error with value and undefined', 'Error handles single parameter correctly')
})

test('QvacErrorBase should handle string messages with additions', t => {
  const STRING_CODE = 1002
  addCodes({
    [STRING_CODE]: {
      name: 'STRING_ERROR',
      message: 'Base message:'
    }
  })

  const error = new QvacErrorBase({ code: STRING_CODE, adds: 'additional info' })
  t.is(error.message, 'Base message: additional info', 'Error appends additional info to string message')
})

test('QvacErrorBase serializes correctly with toJSON', t => {
  const SERIAL_CODE = 1003
  addCodes({
    [SERIAL_CODE]: {
      name: 'SERIAL_ERROR',
      message: 'Serialization test'
    }
  })

  const error = new QvacErrorBase({ code: SERIAL_CODE })
  const serialized = error.toJSON()

  t.is(serialized.code, SERIAL_CODE, 'Serialized error has correct code')
  t.is(serialized.name, 'SERIAL_ERROR', 'Serialized error has correct name')
  t.is(serialized.message, 'Serialization test', 'Serialized error has correct message')
  t.ok(serialized.stack, 'Serialized error includes stack trace')
})

test('addCodes should throw when registering duplicate codes', t => {
  const DUPE_CODE = 1004
  addCodes({
    [DUPE_CODE]: {
      name: 'FIRST_ERROR',
      message: 'First error'
    }
  })

  try {
    addCodes({
      [DUPE_CODE]: {
        name: 'SECOND_ERROR',
        message: 'Second error'
      }
    })
    t.fail('Should throw when registering duplicate code')
  } catch (error) {
    t.ok(error instanceof QvacErrorBase, 'Throws a QvacErrorBase error')
    t.is(error.code, INTERNAL_ERROR_CODES.ERROR_CODE_ALREADY_EXISTS, 'Has the correct error code')
  }
})

test('addCodes should throw with invalid definition', t => {
  const INVALID_CODE = 1005

  try {
    addCodes({
      [INVALID_CODE]: 'not an object'
    })
    t.fail('Should throw with invalid definition')
  } catch (error) {
    t.ok(error instanceof QvacErrorBase, 'Throws a QvacErrorBase error')
    t.is(error.code, INTERNAL_ERROR_CODES.INVALID_CODE_DEFINITION, 'Has the correct error code')
  }
})

test('addCodes should throw when missing name or message', t => {
  const MISSING_CODE = 1006

  try {
    addCodes({
      [MISSING_CODE]: {
        name: 'MISSING_MESSAGE'
        // missing message
      }
    })
    t.fail('Should throw when missing message')
  } catch (error) {
    t.ok(error instanceof QvacErrorBase, 'Throws a QvacErrorBase error')
    t.is(error.code, INTERNAL_ERROR_CODES.MISSING_ERROR_DEFINITION, 'Has the correct error code')
  }
})

test('getRegisteredCodes should return all registered codes', t => {
  // Register a new code for this test
  const TEST_CODE = 1007
  addCodes({
    [TEST_CODE]: {
      name: 'GET_REGISTERED_TEST',
      message: 'Test for getRegisteredCodes'
    }
  })

  const codes = getRegisteredCodes()
  t.ok(codes[TEST_CODE], 'Registered code is present in returned object')
  t.is(codes[TEST_CODE].name, 'GET_REGISTERED_TEST', 'Code has the correct name')
  t.is(codes[TEST_CODE].message, 'Test for getRegisteredCodes', 'Code has the correct message')

  // Verify integrity - modifications to returned object shouldn't affect the original
  codes[TEST_CODE].name = 'MODIFIED'
  const newCodes = getRegisteredCodes()

  t.is(newCodes[TEST_CODE].name, 'GET_REGISTERED_TEST', 'Original registry is not affected by modifications')
})

test('isCodeRegistered should correctly check code registration', t => {
  const REGISTERED_CODE = 1008
  const UNREGISTERED_CODE = 9999

  addCodes({
    [REGISTERED_CODE]: {
      name: 'IS_REGISTERED_TEST',
      message: 'Test for isCodeRegistered'
    }
  })

  t.ok(isCodeRegistered(REGISTERED_CODE), 'Returns true for registered code')
  t.absent(isCodeRegistered(UNREGISTERED_CODE), 'Returns false for unregistered code')
})

test('Extending QvacErrorBase works correctly', t => {
  // Custom error class extending QvacErrorBase
  class CustomError extends QvacErrorBase {
    constructor (options) {
      super(options)
      this.isCustom = true
    }
  }

  const CUSTOM_CODE = 1009
  addCodes({
    [CUSTOM_CODE]: {
      name: 'CUSTOM_ERROR',
      message: 'Custom error test'
    }
  })

  const error = new CustomError({ code: CUSTOM_CODE })
  t.ok(error instanceof Error, 'Custom error is an instance of Error')
  t.ok(error instanceof QvacErrorBase, 'Custom error is an instance of QvacErrorBase')
  t.ok(error instanceof CustomError, 'Custom error is an instance of CustomError')
  t.ok(error.isCustom, 'Custom property is set')
  t.is(error.code, CUSTOM_CODE, 'Custom error has the correct code')
  t.is(error.name, 'CUSTOM_ERROR', 'Custom error has the correct name')
  t.is(error.message, 'Custom error test', 'Custom error has the correct message')
})

test('addCodes with package info should register codes successfully', t => {
  const PKG_CODE = 2000
  const packageInfo = { name: 'test-package', version: '1.0.0' }

  addCodes({
    [PKG_CODE]: {
      name: 'PACKAGE_ERROR',
      message: 'Package-based error'
    }
  }, packageInfo)

  const error = new QvacErrorBase({ code: PKG_CODE })
  t.is(error.code, PKG_CODE, 'Error has the correct code')
  t.is(error.name, 'PACKAGE_ERROR', 'Error has the correct name')
  t.is(error.message, 'Package-based error', 'Error has the correct message')
})

test('addCodes should throw when package info is invalid', t => {
  try {
    addCodes({
      2001: {
        name: 'INVALID_PACKAGE_ERROR',
        message: 'Error with invalid package info'
      }
    }, { name: 'test-package' })
    t.fail('Should throw when package version is missing')
  } catch (error) {
    t.ok(error instanceof QvacErrorBase, 'Throws a QvacErrorBase error')
    t.is(error.code, INTERNAL_ERROR_CODES.INVALID_PACKAGE_INFO, 'Has the correct error code')
  }

  try {
    addCodes({
      2002: {
        name: 'INVALID_PACKAGE_ERROR2',
        message: 'Error with invalid package info'
      }
    }, { version: '1.0.0' })
    t.fail('Should throw when package name is missing')
  } catch (error) {
    t.ok(error instanceof QvacErrorBase, 'Throws a QvacErrorBase error')
    t.is(error.code, INTERNAL_ERROR_CODES.INVALID_PACKAGE_INFO, 'Has the correct error code')
  }
})

test('addCodes should handle package version upgrades', t => {
  const UPGRADE_CODE = 2003
  const packageName = 'upgrade-test-package'

  addCodes({
    [UPGRADE_CODE]: {
      name: 'UPGRADE_ERROR_V1',
      message: 'Version 1 error'
    }
  }, { name: packageName, version: '1.0.0' })

  let error = new QvacErrorBase({ code: UPGRADE_CODE })
  t.is(error.name, 'UPGRADE_ERROR_V1', 'Error has version 1 name')

  addCodes({
    [UPGRADE_CODE]: {
      name: 'UPGRADE_ERROR_V2',
      message: 'Version 2 error'
    }
  }, { name: packageName, version: '2.0.0' })

  error = new QvacErrorBase({ code: UPGRADE_CODE })
  t.is(error.name, 'UPGRADE_ERROR_V2', 'Error has version 2 name after upgrade')
})

test('addCodes should ignore older package versions', t => {
  const VERSION_CODE = 2004
  const packageName = 'version-test-package'

  addCodes({
    [VERSION_CODE]: {
      name: 'VERSION_ERROR_NEW',
      message: 'Newer version error'
    }
  }, { name: packageName, version: '2.0.0' })

  addCodes({
    [VERSION_CODE]: {
      name: 'VERSION_ERROR_OLD',
      message: 'Older version error'
    }
  }, { name: packageName, version: '1.0.0' })

  const error = new QvacErrorBase({ code: VERSION_CODE })
  t.is(error.name, 'VERSION_ERROR_NEW', 'Error keeps newer version name')
})

test('addCodes should throw when different package tries to use same code', t => {
  const CONFLICT_CODE = 2005

  addCodes({
    [CONFLICT_CODE]: {
      name: 'FIRST_PACKAGE_ERROR',
      message: 'First package error'
    }
  }, { name: 'first-package', version: '1.0.0' })

  try {
    addCodes({
      [CONFLICT_CODE]: {
        name: 'SECOND_PACKAGE_ERROR',
        message: 'Second package error'
      }
    }, { name: 'second-package', version: '1.0.0' })
    t.fail('Should throw when different package uses same code')
  } catch (error) {
    t.ok(error instanceof QvacErrorBase, 'Throws a QvacErrorBase error')
    t.is(error.code, INTERNAL_ERROR_CODES.ERROR_CODE_ALREADY_EXISTS, 'Has the correct error code')
  }
})

test('addCodes with package info should handle function messages', t => {
  const FUNC_PKG_CODE = 2006

  addCodes({
    [FUNC_PKG_CODE]: {
      name: 'PACKAGE_FUNCTION_ERROR',
      message: (param1, param2) => `Package error with ${param1} and ${param2}`
    }
  }, { name: 'function-test-package', version: '1.0.0' })

  const error = new QvacErrorBase({ code: FUNC_PKG_CODE, adds: ['pkg1', 'pkg2'] })
  t.is(error.message, 'Package error with pkg1 and pkg2', 'Package-based function message works correctly')
})

test('addCodes with package info should validate code definitions', t => {
  try {
    addCodes({
      2007: 'invalid definition'
    }, { name: 'invalid-package', version: '1.0.0' })
    t.fail('Should throw with invalid definition')
  } catch (error) {
    t.ok(error instanceof QvacErrorBase, 'Throws a QvacErrorBase error')
    t.is(error.code, INTERNAL_ERROR_CODES.INVALID_CODE_DEFINITION, 'Has the correct error code')
  }

  try {
    addCodes({
      2008: {
        name: 'MISSING_MESSAGE_ERROR'
      }
    }, { name: 'invalid-package', version: '1.0.0' })
    t.fail('Should throw when missing message')
  } catch (error) {
    t.ok(error instanceof QvacErrorBase, 'Throws a QvacErrorBase error')
    t.is(error.code, INTERNAL_ERROR_CODES.MISSING_ERROR_DEFINITION, 'Has the correct error code')
  }
})

test('QvacErrorBase: error without cause has its own stack and no cause', t => {
  const CODE = 12345
  addCodes({
    [CODE]: {
      name: 'NO_CAUSE_ERROR',
      message: 'Error without cause'
    }
  })
  try {
    throw new QvacErrorBase({ code: CODE })
  } catch (err) {
    t.is(err.name, 'NO_CAUSE_ERROR', 'Correct error name')
    t.is(err.message, 'Error without cause', 'Correct error message')
    t.is(err.code, CODE, 'Correct error code')
    t.ok(err.stack.includes('QvacErrorBase'), 'Stack trace is present')
    t.absent(err.cause, 'Cause is undefined when not passed')
  }
})

test('QvacErrorBase: error with cause appends original stack', t => {
  const CODE = 12346
  addCodes({
    [CODE]: {
      name: 'WITH_CAUSE_ERROR',
      message: 'Error with cause'
    }
  })
  let originalError
  try {
    throw new TypeError('Original error')
  } catch (err) {
    originalError = err
    try {
      throw new QvacErrorBase({ code: CODE, cause: originalError })
    } catch (wrapped) {
      t.is(wrapped.name, 'WITH_CAUSE_ERROR', 'Correct error name')
      t.is(wrapped.message, 'Error with cause', 'Correct error message')
      t.is(wrapped.code, CODE, 'Correct error code')
      t.ok(wrapped.stack.includes('QvacErrorBase'), 'Stack trace is present')
      t.ok(wrapped.stack.includes('TypeError: Original error'), 'Original error stack is appended')
      t.is(wrapped.cause, originalError, 'Cause is set to original error')
    }
  }
})

test('QvacErrorBase: unknown code sets fallback name and code', t => {
  const err = new QvacErrorBase({ code: 999999 })
  t.is(err.code, 0, 'Unknown code sets code to 0')
  t.is(err.name, 'UNKNOWN_ERROR_CODE', 'Unknown code sets fallback name')
  t.ok(err.message.includes('Unknown QVAC error code'), 'Fallback message is used')
})

test('QvacErrorBase: no code provided sets default name and code', t => {
  const err = new QvacErrorBase({})
  t.is(err.code, 0, 'No code sets code to 0')
  t.is(err.name, 'QvacErrorBase', 'No code sets class name')
  t.is(err.message, 'Unknown QVAC error', 'Default message is used')
})

test('QvacErrorBase: subclass preserves name and stack', t => {
  class CustomError extends QvacErrorBase { }
  const err = new CustomError({})
  t.is(err.name, 'CustomError', 'Subclass name is preserved')
  t.ok(err.stack.includes('CustomError'), 'Subclass stack is present')
})

test('QvacErrorBase: message formatting with function', t => {
  const CODE = 12347
  addCodes({
    [CODE]: {
      name: 'FUNC_MSG_ERROR',
      message: (a, b) => `Func error: ${a} ${b}`
    }
  })
  const err = new QvacErrorBase({ code: CODE, adds: ['foo', 'bar'] })
  t.is(err.message, 'Func error: foo bar', 'Function message formats correctly')
})

test('QvacErrorBase: message formatting with string and additions', t => {
  const CODE = 12348
  addCodes({
    [CODE]: {
      name: 'STR_MSG_ERROR',
      message: 'Base message:'
    }
  })
  const err = new QvacErrorBase({ code: CODE, adds: 'extra' })
  t.is(err.message, 'Base message: extra', 'String message formats correctly')
})

test('QvacErrorBase: toJSON serializes all properties', t => {
  const CODE = 12349
  addCodes({
    [CODE]: {
      name: 'SERIALIZE_ERROR',
      message: 'Serialize error'
    }
  })
  const err = new QvacErrorBase({ code: CODE })
  const json = err.toJSON()
  t.is(json.code, CODE, 'JSON code matches')
  t.is(json.name, 'SERIALIZE_ERROR', 'JSON name matches')
  t.is(json.message, 'Serialize error', 'JSON message matches')
  t.ok(json.stack, 'JSON stack is present')
})
