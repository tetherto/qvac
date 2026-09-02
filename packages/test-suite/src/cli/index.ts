#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { Command } from 'commander'
import { runProducer } from './commands/run-producer.js'
import { runConsumerDesktop } from './commands/run-consumer-desktop.js'
import { runConsumerElectron } from './commands/run-consumer-electron.js'
import { runConsumerSnap } from './commands/run-consumer-snap.js'
import { runBootstrap } from './commands/run-bootstrap.js'
import { buildConsumerMobile } from './commands/build-consumer-mobile.js'
import { buildConsumerElectron } from './commands/build-consumer-electron.js'
import { buildConsumerSnap } from './commands/build-consumer-snap.js'
import { reportCompare } from './commands/report-compare.js'
import { reportFormat } from './commands/report-format.js'
import {
  runLocalDesktop,
  runLocalAndroid,
  runLocalIos,
  runLocalElectron,
  runLocalSnap
} from './commands/run-local.js'

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')
) as {
  version: string
}

const program = new Command()

program
  .name('qvac-test')
  .description('QVAC Test Suite - Distributed testing framework')
  .version(packageJson.version)

program
  .command('run:producer')
  .description('Start test producer/orchestrator')
  .option('--runId <id>', 'Unique run identifier')
  .option('--mqtt-broker <url>', 'MQTT broker URL (overrides config)')
  .option('--config <path>', 'Path to config directory', process.cwd())
  .option(
    '--consumer-timeout <seconds>',
    'Timeout waiting for consumer connection (default: 30)',
    '30'
  )
  .option(
    '--consumer-inactivity-timeout <seconds>',
    'Timeout for consumer inactivity/heartbeat (default: 120)',
    '120'
  )
  .option(
    '--filter <categories>',
    'Filter tests by category or testId prefix (comma-separated, e.g., "model,completion")'
  )
  .option(
    '--suite <suites>',
    'Include only tests in these suites (comma-separated, e.g., "smoke,regression")'
  )
  .option(
    '--exclude-suite <suites>',
    'Exclude tests in these suites (comma-separated, e.g., "slow,flaky")'
  )
  .option(
    '--also-tests <testIds>',
    'Run these exact testIds in addition to the suite/filter selection (comma-separated). ' +
      'Unlike --filter, which narrows, this unions — e.g. --suite=smoke --also-tests=a,b runs smoke plus a and b'
  )
  .option(
    '--report-dir <dir>',
    'Directory to write reports + read device-mem.ndjson from (used by run:local; producer also writes test-timeline.ndjson here)'
  )
  .action(runProducer)

program
  .command('run:consumer:desktop')
  .description('Run desktop consumer (imports entry from config in-place)')
  .requiredOption('--runId <id>', 'Unique run identifier (must match producer)')
  .option('--mqtt-broker <url>', 'MQTT broker URL (overrides config)')
  .option('--config <path>', 'Path to config directory', process.cwd())
  .option('--platform <platform>', 'Platform name', 'desktop')
  .action(runConsumerDesktop)

program
  .command('run:consumer:electron')
  .description('Package and run Electron consumer app')
  .requiredOption('--runId <id>', 'Unique run identifier (must match producer)')
  .option('--mqtt-broker <url>', 'MQTT broker URL (overrides config)')
  .option('--config <path>', 'Path to config directory', process.cwd())
  .option(
    '--platform <platform>',
    'Target Electron platform (macos, windows, linux, darwin, win32)'
  )
  .option('--arch <arch>', 'Target architecture', process.arch)
  .option('--skip-build', 'Skip packaging, only launch existing packaged app')
  .option('--skip-install', 'Skip Electron app dependency install before packaging')
  .action(runConsumerElectron)

program
  .command('run:consumer:snap')
  .description('Build, install, and run a strict-confined Electron Snap consumer')
  .requiredOption('--runId <id>', 'Unique run identifier (must match producer)')
  .option('--mqtt-broker <url>', 'MQTT broker URL (overrides config)')
  .option('--config <path>', 'Path to config directory', process.cwd())
  .option('--skip-build', 'Skip Snap package build')
  .option('--skip-install', 'Skip app dependency install before packaging')
  .option('--skip-snap-install', 'Skip installation of the built Snap')
  .action(runConsumerSnap)

program
  .command('run:bootstrap:desktop')
  .description(
    'Run bootstrap from desktop consumer entry (e.g., pre-download models for CI caching)'
  )
  .option('--config <path>', 'Path to config directory', process.cwd())
  .action((opts) => runBootstrap({ ...opts, consumer: 'desktop' }))

program
  .command('run:bootstrap:electron')
  .description(
    'Run bootstrap from Electron consumer entry (e.g., pre-download models for CI caching)'
  )
  .option('--config <path>', 'Path to config directory', process.cwd())
  .action((opts) => runBootstrap({ ...opts, consumer: 'electron' }))

program
  .command('run:bootstrap:snap')
  .description('Build, install, and run bootstrap inside the Electron Snap consumer')
  .option('--config <path>', 'Path to config directory', process.cwd())
  .option('--skip-build', 'Skip Snap package build')
  .option('--skip-install', 'Skip app dependency install before packaging')
  .option('--skip-snap-install', 'Skip installation of the built Snap')
  .action((opts) =>
    runConsumerSnap({
      ...opts,
      runId: `snap-bootstrap-${Date.now()}`,
      mode: 'bootstrap'
    })
  )

program
  .command('build:consumer:android')
  .description('Build Android consumer (.apk)')
  .option('--config <path>', 'Path to config directory', process.cwd())
  .option('--runId <id>', 'Bake runId into build (required for mobile)')
  .option('--mqtt-broker <url>', 'Override MQTT broker URL')
  .action((opts) => buildConsumerMobile({ ...opts, platform: 'android' }))

program
  .command('build:consumer:ios')
  .description('Build iOS consumer (.ipa)')
  .option('--config <path>', 'Path to config directory', process.cwd())
  .option('--runId <id>', 'Bake runId into build (required for mobile)')
  .option('--mqtt-broker <url>', 'Override MQTT broker URL')
  .action((opts) => buildConsumerMobile({ ...opts, platform: 'ios' }))

program
  .command('build:consumer:electron')
  .description('Package Electron consumer app')
  .option('--config <path>', 'Path to config directory', process.cwd())
  .option(
    '--platform <platform>',
    'Target Electron platform (macos, windows, linux, darwin, win32)'
  )
  .option('--arch <arch>', 'Target architecture', process.arch)
  .option('--skip-install', 'Skip Electron app dependency install before packaging')
  .action(buildConsumerElectron)

program
  .command('build:consumer:snap')
  .description('Build strict-confined Electron Snap consumer package')
  .option('--config <path>', 'Path to config directory', process.cwd())
  .option('--skip-install', 'Skip app dependency install before packaging')
  .action(async (opts) => {
    await buildConsumerSnap(opts)
  })

program
  .command('report:compare')
  .description('Compare test results between baseline and current')
  .requiredOption('--baseline <file>', 'Baseline JSON report file')
  .requiredOption('--current <file>', 'Current JSON report file')
  .requiredOption('--output <file>', 'Output comparison JSON file')
  .action(reportCompare)

program
  .command('report:format')
  .description('Format comparison JSON to markdown')
  .requiredOption('--input <file>', 'Comparison JSON file')
  .requiredOption('--format <format>', 'Output format (markdown)')
  .option('--output <file>', 'Output file (optional, prints to stdout if not specified)')
  .action(reportFormat)

// ---------------------------------------------------------------------------
// run:local:* — one-liner local development commands
// ---------------------------------------------------------------------------

const addLocalOpts = (cmd: Command) =>
  cmd
    .option('--config <path>', 'Path to config directory', process.cwd())
    .option('--runId <id>', 'Run identifier (auto-generated if omitted)')
    .option('--filter <categories>', 'Filter tests by category (forwarded to producer)')
    .option('--suite <suites>', 'Include only these suites (forwarded to producer)')
    .option('--exclude-suite <suites>', 'Exclude these suites (forwarded to producer)')
    .option(
      '--also-tests <testIds>',
      'Exact testIds to run on top of the suite/filter selection (forwarded to producer)'
    )
    .option('--report-dir <dir>', 'Custom report directory')

addLocalOpts(program.command('run:local:desktop'))
  .description('Run producer + desktop consumer locally (one command)')
  .action(runLocalDesktop)

addLocalOpts(program.command('run:local:electron'))
  .description('Package Electron consumer app + run producer locally')
  .option('--skip-build', 'Skip Electron package build, only launch existing packaged app')
  .option('--skip-install', 'Skip Electron app dependency install before packaging')
  .option(
    '--platform <platform>',
    'Target Electron platform (macos, windows, linux, darwin, win32)'
  )
  .option('--arch <arch>', 'Target architecture', process.arch)
  .action(runLocalElectron)

addLocalOpts(program.command('run:local:snap'))
  .description('Build, install, and run Electron Snap consumer + producer locally')
  .option('--skip-build', 'Skip Snap package build')
  .option('--skip-install', 'Skip app dependency install before packaging')
  .option('--skip-snap-install', 'Skip installation of the built Snap')
  .action(runLocalSnap)

addLocalOpts(program.command('run:local:android'))
  .description('Build, install, launch Android consumer + run producer locally')
  .option('--skip-build', 'Skip build, only install+launch existing APK')
  .option('--device <serial>', 'Target specific Android device')
  .action(runLocalAndroid)

addLocalOpts(program.command('run:local:ios'))
  .description('Build, install, launch iOS consumer + run producer locally')
  .option('--skip-build', 'Skip build, only install+launch existing .app')
  .option('--bundle-suffix <suffix>', 'iOS bundle ID suffix (default: OS username)')
  .option('--device <udid>', 'Target specific iOS device')
  .action(runLocalIos)

program.parse()
