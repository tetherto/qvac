export interface SkillRequires {
  readonly bins?: readonly string[]
  readonly binMinVersions?: Readonly<
    Record<string, { readonly min: string; readonly command?: string }>
  >
}

export interface SkillSetupRoute {
  readonly kind: 'oauth' | 'token' | 'install' | 'picker' | 'instructions'
  readonly label: string
  readonly description?: string
  readonly helpUrl?: string
  readonly steps?: readonly string[]
}

export interface SkillSetup {
  readonly summary?: string
  readonly routes?: readonly SkillSetupRoute[]
}
