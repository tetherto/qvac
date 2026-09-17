declare module '*qvac-platform-addons.mjs' {
  export const HOST_ADDON_IMPORT: '#host-addon'

  export function resolvePlatformAddonRoots(
    projectRoot: string,
    addonNames: string[],
    platform: string
  ): Array<{ dir: string; pkg: { name?: string; version?: string; addon?: boolean } }>

  export function resolveAddonPlatformPackage(
    metaName: string,
    hostAddon: unknown,
    host: string
  ): string | null

  export function resolvePlatformPackageName(hostAddon: unknown, host: string): string | null
}
