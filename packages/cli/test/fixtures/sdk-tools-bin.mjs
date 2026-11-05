#!/usr/bin/env node

// Stands in for the `qvac-sdk` binary: prints the argv it was started with and
// exits with FIXTURE_EXIT_CODE.
process.stdout.write(`${JSON.stringify({ bin: process.argv[1], args: process.argv.slice(2) })}\n`)
process.exitCode = Number(process.env.FIXTURE_EXIT_CODE ?? 0)
