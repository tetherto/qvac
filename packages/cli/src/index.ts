#!/usr/bin/env node

import { run } from './cli.js'

await run(process.argv.slice(2))
