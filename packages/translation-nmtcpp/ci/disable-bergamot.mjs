#!/usr/bin/env node
// The C++ tests build without Bergamot: linking bergamot-translator clashes with gtest's headers, as main noted.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = fileURLToPath(new URL('..', import.meta.url))
writeFileSync(
  join(PKG, 'config.cmake'),
  'set(USE_BERGAMOT OFF CACHE BOOL "Disable Bergamot for tests" FORCE)\n'
)
console.log('config.cmake: USE_BERGAMOT OFF')
