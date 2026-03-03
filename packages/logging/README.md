# logging

`logging` wraps any logger you supply and normalizes the interface.

## Installation

```bash
npm install @qvac/logging
```

## Usage

### Import

```js
// ES Modules
import QvacLogger from '@qvac/logging'

// CommonJS
const QvacLogger = require('@qvac/logging')
```

### Create a Logger Wrapper

```js
// Wrap an existing logger instance:
const log = new QvacLogger(myLogger)
```

- **With a provided logger**:
    1. If `logger.getLevel()` exists, its return value (case-insensitive) is used.
    2. Else if `logger.level()` exists, its return (case-insensitive) is used.
    3. Else if `logger.level` is a string, it’s used (case-insensitive).
    4. If none yield a valid level, falls back to `DEFAULT_LEVEL` (`"info"`).
- **Without a logger**:
    - The wrapper starts in `OFF` mode and silences all messages.

### Log Levels

Constants available on `QvacLogger.LOG_LEVELS`:

```js
console.log(QvacLogger.LOG_LEVELS)
// {
//   OFF:   'off',
//   ERROR: 'error',
//   WARN:  'warn',
//   INFO:  'info',
//   DEBUG: 'debug'
// }
```

### Logging Methods

- `log.error(...args)`
- `log.warn(...args)`
- `log.info(...args)`
- `log.debug(...args)`

Each method forwards to the corresponding function on the wrapped logger only if the message’s level is at‑or‑above the
active threshold.

### Changing Log Level

Note that changing the log level on the wrapper does not change the level of the underlying logger and vice versa.

If you need to change the log level you need to call method on both the wrapper and the underlying logger.

For example:
```js
import * as logLevel from 'loglevel'
import QvacLogger from '@qvac/logging'

logLevel.setLevel('warn')
const log = new QvacLogger(logLevel)

console.log(log.getLevel())    // 'warn'
log.info('Info here')          // skipped
log.error('Critical!')         // forwarded to logLevel.error

logLevel.setLevel('debug')     // change logLevel level
log.setLevel('debug')          // change wrapper level
console.log(log.getLevel())    // 'debug'
log.debug('Debugging now!')   // forwarded to logLevel.debug
```


## Quickstart Example

```js
import * as logLevel from 'loglevel'
import QvacLogger from '@qvac/logging'

logLevel.setLevel('warn')
const log = new QvacLogger(logLevel)

console.log(log.getLevel())    // 'warn'
log.info('Info here')          // skipped
log.error('Critical!')         // forwarded to logLevel.error
```

## SDK Integration Example

```js
import Qvac from '@qvac/sdk'
import QvacLogger from '@qvac/logging'
import * as logLevel from 'loglevel'

logLevel.setLevel('debug')
const log = new QvacLogger(logLevel)

const qvac = new Qvac({logger: log})
await qvac.start()
```

## Testing

Run unit tests with:

```bash
npm test
```

