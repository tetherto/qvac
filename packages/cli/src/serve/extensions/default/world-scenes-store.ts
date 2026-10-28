import { randomUUID } from 'node:crypto'

const DEFAULT_MAX_ENTRIES = 256

export interface WorldSceneRecord {
  id: string
  alias: string
  /** The load the scene lives on; a reload drops it. */
  sdkModelId: string
  created: number
  width?: number
  height?: number
  sceneCreateMs?: number
}

export interface WorldScenesStore {
  readonly maxEntries: number
  add(scene: Omit<WorldSceneRecord, 'id' | 'created'>): WorldSceneRecord
  get(id: string): WorldSceneRecord | undefined
  /** The model holds one live scene, so creating one retires the alias's older ids. */
  isActive(scene: WorldSceneRecord, sdkModelId: string | undefined): boolean
}

export function createWorldScenesStore(maxEntries = DEFAULT_MAX_ENTRIES): WorldScenesStore {
  const scenes = new Map<string, WorldSceneRecord>()
  const active = new Map<string, string>()

  return {
    maxEntries,
    add(fields) {
      const scene: WorldSceneRecord = {
        ...fields,
        id: `scene_${randomUUID()}`,
        created: Math.floor(Date.now() / 1000)
      }
      scenes.set(scene.id, scene)
      active.set(scene.alias, scene.id)
      // Drop the oldest retired ids first; a live scene is never evicted.
      for (const id of scenes.keys()) {
        if (scenes.size <= maxEntries) break
        const alias = scenes.get(id)!.alias
        if (active.get(alias) !== id) scenes.delete(id)
      }
      return scene
    },
    get(id) {
      return scenes.get(id)
    },
    isActive(scene, sdkModelId) {
      return active.get(scene.alias) === scene.id && scene.sdkModelId === sdkModelId
    }
  }
}
