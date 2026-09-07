declare const platform: {
  PREBUILT_HOSTS: string[]
  platformPackageName(platform?: string, arch?: string): string | null
  resolvePlatformPrebuilds(): string | null
  runtimeHost(): { platform: string | undefined, arch: string | undefined }
}

export = platform
