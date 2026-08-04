import type HyperDB from 'hyperdb'

export interface ProfileApplyContext {
  readonly transaction: ReturnType<HyperDB['transaction']>
  readonly deviceId: Buffer
  readonly recordedAt: number
  readonly expectedRevision?: string
  readonly revision: string
}

export interface ProfilePrepareContext {
  readonly deviceId: Buffer
  readonly recordedAt: number
}

export interface SyncProfileRuntime {
  readonly id: string
  readonly version: number
  prepare(command: Buffer, context: ProfilePrepareContext): Buffer
  apply(command: Buffer, context: ProfileApplyContext): Promise<boolean>
  query(query: Buffer, database: HyperDB): Promise<Buffer>
}

export class ProfileRegistry {
  private readonly profiles = new Map<string, SyncProfileRuntime>()

  register(profile: SyncProfileRuntime) {
    if (this.profiles.has(profile.id)) {
      throw new Error(`Sync profile is already registered: ${profile.id}`)
    }
    this.profiles.set(profile.id, profile)
  }

  require(id: string, version?: number) {
    const profile = this.profiles.get(id)
    if (!profile) throw new Error(`Sync profile is not installed: ${id}`)
    if (version != null && version !== profile.version) {
      throw new Error(
        `Sync profile ${id} version ${version} is incompatible with installed version ${profile.version}`
      )
    }
    return profile
  }
}
