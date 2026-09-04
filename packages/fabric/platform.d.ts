declare const platform: {
  platformPackageName(platform?: string, arch?: string): string | null
  resolvePlatformPrebuilds(): string | null
}

export = platform
