import { handleError } from '@/lib/errors'

export const handler0 = async (options: {
  config?: string
  sdkPath?: string
  host: string[]
  defer: string[]
  install: boolean
  quiet?: boolean
  verbose?: boolean
  offline?: boolean
}) => {
  try {
    const { bundleSdk, HostPrebuildsInstallFailedError, HostPrebuildsInstallRefusedError } =
      await import('@/lib/bundle-sdk/index')
    const bundleOptions = {
      projectRoot: process.cwd(),
      configPath: options.config,
      sdkPath: options.sdkPath,
      hosts: options.host.length > 0 ? options.host : undefined,
      defer: options.defer.length > 0 ? options.defer : undefined,
      quiet: options.quiet,
      verbose: options.verbose,
      network: options.offline !== true
    }

    try {
      const result = await bundleSdk({
        ...bundleOptions,
        installMissingPrebuilds: options.install
      })
      if (result.installedPrebuilds.length > 0 && !options.quiet) {
        console.log('📦 Installed addon platform packages:')
        for (const pkg of result.installedPrebuilds) {
          console.log(`   ${pkg.name}@${pkg.version} (${pkg.hosts.join(', ')})`)
        }
      }
    } catch (error: unknown) {
      if (
        !(error instanceof HostPrebuildsInstallRefusedError) &&
        !(error instanceof HostPrebuildsInstallFailedError)
      ) {
        throw error
      }
      // The install is a convenience: report what to add by hand and
      // bundle with what is installed. Without the packages, bundling
      // fails with HostPrebuildsMissingError naming the same pins.
      console.warn(`\n⚠️  ${error.message}\n`)
      console.warn('   Bundling without installing them. Pass --no-install to skip this step.\n')
      await bundleSdk(bundleOptions)
    }
  } catch (error: unknown) {
    handleError(error)
    process.exit(1)
  }
}
