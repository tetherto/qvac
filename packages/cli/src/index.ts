#!/usr/bin/env node
import { runSdkCommand } from './cli/sdk-entry.js'
import { sdkArguments } from './cli/commands/sdk/arguments.js'

const argv = process.argv.slice(2)
await runSdkCommand(sdkArguments(argv) ?? argv)
