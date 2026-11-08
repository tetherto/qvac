#!/usr/bin/env node
// A minimal Commander CLI, shaped like packages/cli/src/index.ts, for the
// command-tree walker's tests. Running it would parse process.argv; the walker
// only reads it.
import { Command } from 'commander'
import { registerGreetCommand } from './greet/command'

function setupCli(): void {
  const program = new Command()
  program.name('demo').description('A demo CLI').version('1.0.0')
  registerGreetCommand(program)
  program.parse()
}

setupCli()
