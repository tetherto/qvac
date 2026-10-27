import { handleError } from '@/lib/errors'

export const handler0 = async (options: {
  base: string
  head: string
  lockfile: string
  quiet?: boolean
}) => {
  try {
    const { formatVerifyDepsResult, hasNativeChanges, verifyDeps } =
      await import('@/lib/verify/deps/index')
    const result = await verifyDeps({
      projectRoot: process.cwd(),
      base: options.base,
      head: options.head,
      lockfilePath: options.lockfile
    })

    const changed = hasNativeChanges(result)
    if (!options.quiet || changed) {
      console.log(formatVerifyDepsResult(result))
    }
    if (changed) process.exit(1)
  } catch (error: unknown) {
    handleError(error)
    process.exit(2)
  }
}

export const handler1 = async (options: {
  addonsSource: string
  host: string[]
  bareRuntimeVersion?: string
  config?: string
  projectRoot?: string
  json?: boolean
  quiet?: boolean
  offline?: boolean
}) => {
  try {
    // verifyBundle in @qvac/sdk/commands already emits an `invalid-source`
    // issue with message "At least one host is required." when hosts is
    // empty — no need to duplicate the guard here.
    const { formatVerifyBundleResult, hasErrors, verifyBundle } =
      await import('@/lib/verify/bundle/index')
    const verifyOptions: Parameters<typeof verifyBundle>[0] = {
      projectRoot: options.projectRoot ?? process.cwd(),
      addonsSource: options.addonsSource,
      hosts: options.host
    }
    if (options.bareRuntimeVersion) {
      verifyOptions.bareRuntimeVersion = options.bareRuntimeVersion
    }
    if (options.config) {
      verifyOptions.configPath = options.config
    }
    if (options.offline) {
      verifyOptions.network = false
    }
    if (!options.quiet) {
      // stderr keeps `--json` output on stdout parseable.
      verifyOptions.onProgress = (message) => process.stderr.write(`… ${message}\n`)
    }
    const result = await verifyBundle(verifyOptions)
    const failed = hasErrors(result)
    if (options.json) {
      console.log(JSON.stringify(result, null, 2))
    } else if (!options.quiet || failed || result.issues.length > 0) {
      console.log(formatVerifyBundleResult(result))
    }
    if (failed) process.exit(1)
  } catch (error: unknown) {
    handleError(error)
    process.exit(1)
  }
}
