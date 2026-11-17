import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Command } from 'commander'
import { handleError } from '@/errors'

export function registerAppCommand(program: Command): void {
  program
    .command('app')
    .description('Run the QV.AC app CLI, downloading it on first use')
    .argument('[args...]', 'Arguments for the QV.AC app CLI')
    .helpOption(false)
    .allowUnknownOption()
    .action(runAppCli)
}

export async function runAppCli(args: string[]): Promise<void> {
  try {
    const { ensureAppBinary, resolveBaseUrl } = await import('@/app/binary')
    const { privateDir, privateTempDir, runBinary } = await import('@/app/run')
    const dir = await privateDir(
      process.env['QVAC_APP_CLI_DIR'] || join(homedir(), '.qvac', 'app-cli')
    )
    const file = await ensureAppBinary({
      baseUrl: resolveBaseUrl(process.env['QVAC_APP_CLI_URL']),
      dir,
      hostKey: `${process.platform}-${process.arch}`,
      now: Date.now()
    })
    const versionDir = dirname(file)
    const marker = join(versionDir, 'run', String(process.pid))
    await mkdir(dirname(marker), { recursive: true, mode: 0o700 })
    await writeFile(marker, '')
    let code: number
    try {
      code = await runBinary(file, args, await privateTempDir(join(versionDir, 'tmp')))
    } finally {
      await rm(marker, { force: true })
    }
    process.exit(code)
  } catch (error: unknown) {
    handleError(error)
    process.exit(1)
  }
}
