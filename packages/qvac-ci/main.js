#!/usr/bin/env node
'use strict'

const { command, flag, summary, header } = require('paparam')
const { version } = require('./package.json')
const { pendingApprovals } = require('./lib/commands')

// Subcommands are passed as direct positional arguments to command().
// There is no subs() wrapper — this matches the paparam pattern.
//
// To add a new subcommand:
//   1. Create lib/commands/<name>/index.js (extend Command, implement toCommand() + _run())
//   2. Create lib/commands/<name>/helpers.js (domain logic, read secrets from process.env)
//   3. Add newCmd.toCommand() as a positional arg below
//   4. Write test/unit/<name>-index.test.js and test/unit/<name>-helpers.test.js

const prog = command(
  'qvac-ci',
  header('qvac-ci v' + version),
  summary('CI utilities for the QVAC monorepo'),
  flag('--version|-v', 'Print version and exit'),
  pendingApprovals.toCommand()
)

prog.parse()
