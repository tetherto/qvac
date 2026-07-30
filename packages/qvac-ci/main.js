#!/usr/bin/env node
import { createRequire } from 'module'
import { command, flag, summary, header } from './lib/cli.js'
import { commands } from './lib/commands/index.js'

const { version } = createRequire(import.meta.url)('./package.json')

// Commands are registered in lib/commands/index.js — see README for how to add one.
const prog = command(
  'qvac-ci',
  header('qvac-ci v' + version),
  summary('CI utilities for the QVAC monorepo'),
  flag('--version|-v', 'Print version and exit'),
  ...commands,
  () => {
    if (prog.flags.version) {
      process.stdout.write('qvac-ci v' + version + '\n')
      return
    }
    process.stderr.write('Missing command. Run with --help for usage.\n')
    process.exit(1)
  }
)

prog.parse()
