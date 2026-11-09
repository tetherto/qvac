import { randomUUID } from 'node:crypto'

const DEFAULT_MAX_ENTRIES = 256

export interface WorldSceneRecord {
  id: string
  alias: string
  /** Aliases with the same type, src and config share this SDK model, and so its scene. */
  sdkModelId: string
  /** The model load the scene lives on; a reload drops it. */
  loadCount: number
  created: number
  width?: number
  height?: number
  sceneCreateMs?: number
}

export interface WorldScenesStore {
  readonly maxEntries: number
  add(scene: Omit<WorldSceneRecord, 'id' | 'created'>): WorldSceneRecord
  get(id: string): WorldSceneRecord | undefined
  /** The SDK model holds one live scene, so creating one retires older ids on it, from any alias. */
  isActive(scene: WorldSceneRecord, loadCount: number | undefined): boolean
}

export function createWorldScenesStore(maxEntries = DEFAULT_MAX_ENTRIES): WorldScenesStore {
  const scenes = new Map<string, WorldSceneRecord>()
  // sdkModelId -> live scene id
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
      active.set(scene.sdkModelId, scene.id)
      // Drop the oldest retired ids first; a live scene is never evicted.
      for (const id of scenes.keys()) {
        if (scenes.size <= maxEntries) break
        if (active.get(scenes.get(id)!.sdkModelId) !== id) scenes.delete(id)
      }
      return scene
    },
    get(id) {
      return scenes.get(id)
    },
    isActive(scene, loadCount) {
      return active.get(scene.sdkModelId) === scene.id && scene.loadCount === loadCount
    }
  }
}
