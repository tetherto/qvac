import qvacCrypto from '#crypto'

import { importers } from './imports.js'
import type { IndexStorage, SnapshotFileSystem } from '../types.js'

// What a snapshot was taken of. A snapshot is used only when every field
// matches the namespace, so a namespace re-created under the same name, or a
// directory shared by two stores, never loads another's index.
export interface SnapshotIdentity {
  namespace: string
  createdAt: number
  spaceId: string
  storage: IndexStorage
  dimensions: number
}

interface Sidecar extends SnapshotIdentity {
  version: 1
  revision: number
  file: string
}

export interface StoredSnapshot {
  path: string
  revision: number
}

export interface SnapshotWrite {
  revision: number
  written: Promise<void>
}

export interface SnapshotStore {
  read(identity: SnapshotIdentity): Promise<StoredSnapshot | null>
  // `start` must read the revision and start the native write synchronously.
  write(
    identity: SnapshotIdentity,
    start: (pathFor: (revision: number) => string) => SnapshotWrite
  ): Promise<number>
  // Deletes the namespace's sidecar and snapshot files, unless they belong to
  // a later namespace of the same name.
  remove(namespace: string, createdAt: number): Promise<void>
  // Deletes the namespace's snapshot files its sidecar doesn't name, such as
  // the temp file of a write the process was killed in.
  clean(namespace: string): Promise<void>
}

export type FileSystem = SnapshotFileSystem

// Files live under `<dir>/<core key>/`, one sidecar per namespace naming the
// snapshot it describes. A snapshot gets a new file per revision and the
// sidecar is renamed into place after it, so a crash at any point leaves a
// sidecar that matches the file it names.
export function createSnapshotStore(
  dir: string,
  coreKey: string,
  files: FileSystem
): SnapshotStore {
  const root = `${dir}/${coreKey}`

  function base(namespace: string): string {
    return qvacCrypto.createHash('sha256').update(namespace).digest('hex').slice(0, 32) as string
  }

  // Null when there is no sidecar; any other read or parse failure throws.
  async function readSidecar(namespace: string): Promise<Sidecar | null> {
    let text: string
    try {
      text = await files.readFile(`${root}/${base(namespace)}.json`, 'utf8')
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'ENOENT') return null
      throw error
    }
    return JSON.parse(text) as Sidecar
  }

  // Only `<base>.<revision>.tvec`, TurboVec's `<base>.<revision>.tvec.tmp.*`
  // and `<base>.json.tmp` are touched: nothing else in the directory is ours.
  async function sweep(name: string, keep: string | null): Promise<void> {
    if (!files.readdir) return
    let names: string[]
    try {
      names = await files.readdir(root)
    } catch {
      return
    }
    const own = new RegExp(`^${name}\\.(\\d+\\.tvec(\\.tmp\\..+)?|json\\.tmp)$`)
    for (const file of names) {
      if (file !== keep && own.test(file)) await files.unlink(`${root}/${file}`).catch(() => {})
    }
  }

  return {
    async read(identity) {
      const sidecar = await readSidecar(identity.namespace)
      if (!sidecar || sidecar.version !== 1) return null
      if (
        sidecar.namespace !== identity.namespace ||
        sidecar.createdAt !== identity.createdAt ||
        sidecar.spaceId !== identity.spaceId ||
        sidecar.storage !== identity.storage ||
        sidecar.dimensions !== identity.dimensions ||
        !Number.isInteger(sidecar.revision) ||
        typeof sidecar.file !== 'string' ||
        sidecar.file.includes('/')
      ) {
        return null
      }
      return { path: `${root}/${sidecar.file}`, revision: sidecar.revision }
    },

    async write(identity, start) {
      await files.mkdir(root, { recursive: true })
      const name = base(identity.namespace)
      // An unreadable sidecar is replaced below.
      const previous = await readSidecar(identity.namespace).catch(() => null)
      const fileFor = (revision: number) => `${name}.${revision}.tvec`
      const { revision, written } = start((revision) => `${root}/${fileFor(revision)}`)
      const file = fileFor(revision)
      try {
        await written
      } catch (error) {
        // Keep the file if the sidecar still names it.
        if (previous?.file !== file) await files.unlink(`${root}/${file}`).catch(() => {})
        throw error
      }

      const sidecar: Sidecar = { version: 1, ...identity, revision, file }
      const sidecarPath = `${root}/${name}.json`
      try {
        await files.writeFile(`${sidecarPath}.tmp`, JSON.stringify(sidecar))
        await files.rename(`${sidecarPath}.tmp`, sidecarPath)
      } catch (error) {
        if (previous?.file !== file) await files.unlink(`${root}/${file}`).catch(() => {})
        throw error
      }

      if (previous && previous.file !== file && !previous.file.includes('/')) {
        await files.unlink(`${root}/${previous.file}`).catch(() => {})
      }
      await sweep(name, file)
      return revision
    },

    async remove(namespace, createdAt) {
      const sidecar = await readSidecar(namespace).catch(() => null)
      if (sidecar && sidecar.createdAt !== createdAt) return
      await files.unlink(`${root}/${base(namespace)}.json`).catch(() => {})
      if (sidecar && typeof sidecar.file === 'string' && !sidecar.file.includes('/')) {
        await files.unlink(`${root}/${sidecar.file}`).catch(() => {})
      }
      await sweep(base(namespace), null)
    },

    async clean(namespace) {
      let sidecar: Sidecar | null
      try {
        sidecar = await readSidecar(namespace)
      } catch {
        return
      }
      await sweep(base(namespace), typeof sidecar?.file === 'string' ? sidecar.file : null)
    }
  }
}

let loadingFs: Promise<FileSystem> | null = null

// Cached like the index module, and loaded by `ready()` for the same reason.
export function loadSnapshotFileSystem(): Promise<FileSystem> {
  if (!loadingFs) loadingFs = importFs()
  return loadingFs
}

export function forgetSnapshotFileSystem(): void {
  loadingFs = null
}

// `#fs` is `bare-fs` on Bare and `fs` on Node.
async function importFs(): Promise<FileSystem> {
  const module = (await importers.fs()) as { promises: FileSystem }
  return module.promises
}
