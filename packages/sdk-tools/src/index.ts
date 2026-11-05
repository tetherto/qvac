#!/usr/bin/env node

import { createRequire } from 'node:module'
import { Command } from 'commander'
import { registerBundleCommand } from '@/bundle-sdk/command'
import { registerConfigureCommand } from '@/configure/command'
import { registerDoctorCommand } from '@/doctor/command'
import { registerOpenAiCommand } from '@/openai/command'
import { registerServeCommand } from '@/serve/command'
import { registerVerifyCommand } from '@/verify/command'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version: string }

function setupCli(): void {
  const program = new Command()

  program
    .name('qvac sdk')
    .description(
      'QVAC SDK tools: OpenAI-compatible server, worker bundler, doctor, configure and verify'
    )
    .version(pkg.version)

  registerBundleCommand(program)
  registerDoctorCommand(program)
  registerConfigureCommand(program)
  registerVerifyCommand(program)
  registerOpenAiCommand(program)
  registerServeCommand(program)

  program.parse()
}

setupCli()
