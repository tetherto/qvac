# @qvac/error-base

This library provides standardized error handling capabilities for all QVAC libraries. It ensures consistency in error reporting, serialization, and handling across the entire QVAC ecosystem.

## Installation

```bash
npm i @qvac/error-base
```

## Features

- Base error class extending native Error
- Standardized error codes and messages
- Support for dynamic error messages with parameters
- Error serialization for logging and API responses
- Registry system for error code management
- Mechanisms to prevent error code conflicts

## Usage

### Basic Usage

```javascript
const { QvacErrorBase, addCodes } = require('@qvac/error-base')

// Create your own error class extending the base
class QvacErrorCustom extends QvacErrorBase {
  constructor(code, adds) {
    super(code, adds)
  }
}

// Define your error codes (reserve at least 1000 codes per library)
const ERR_CODES = Object.freeze({
  VALIDATION_ERROR: 1000,
  CONNECTION_ERROR: 1001,
  TIMEOUT_ERROR: 1002
})

// Register your error codes and their messages
addCodes({
  [ERR_CODES.VALIDATION_ERROR]: {
    name: 'VALIDATION_ERROR',
    message: (...field) => `Validation failed for field: ${field}`
  },
  [ERR_CODES.CONNECTION_ERROR]: {
    name: 'CONNECTION_ERROR',
    message: 'Failed to establish connection'
  },
  [ERR_CODES.TIMEOUT_ERROR]: {
    name: 'TIMEOUT_ERROR',
    message: (timeout) => `Operation timed out after ${timeout}ms`
  }
})

// Using your custom errors
try {
  // Some operation that fails
  throw new QvacErrorCustom(ERR_CODES.VALIDATION_ERROR, 'username')
} catch (error) {
  console.error(error.message) // "Validation failed for field: username"
  console.error(error.code)    // 1000
  console.error(error.name)    // "VALIDATION_ERROR"
}
```

### Error Code Conventions

- Each library should reserve a range of at least 1000 codes
- Keep codes in ascending order based on abstraction level
- Base libraries should have lower code ranges
- Document your code range to avoid conflicts with other libraries

### API Reference

#### `QvacErrorBase`

Base error class that extends the native Error.

```javascript
new QvacErrorBase(code, adds)
```

- `code` (Number): The error code
- `adds` (Array|String): Additional parameters to format the error message

#### `addCodes(codes)`

Register new error codes.

- `codes` (Object): Map of error codes to their definitions

#### `getRegisteredCodes()`

Get all registered error codes and their definitions.

#### `isCodeRegistered(code)`

Check if a code is already registered.

- `code` (Number): The error code to check

#### `INTERNAL_ERROR_CODES`

Reserved internal error codes:

- `UNKNOWN_ERROR_CODE`: 0
- `INVALID_CODE_DEFINITION`: 1
- `ERROR_CODE_ALREADY_EXISTS`: 2
- `MISSING_ERROR_DEFINITION`: 3

## Development

After cloning, run `npm install`. If npm lifecycle scripts are disabled, also run `npm run prepare` to initialize git hooks.

## Best Practices

1. Create a dedicated errors file/module in each library
2. Extend `QvacErrorBase` with a library-specific class name (e.g., `QvacErrorAgent`)
3. Keep all error codes in a separate, well-documented module
4. Use descriptive error names and clear messages
5. Avoid relying on error messages for logic (use codes instead)
6. Consider generating documentation from your error codes
