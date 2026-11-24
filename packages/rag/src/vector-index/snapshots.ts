import qvacCrypto from '#crypto'

import type { IndexStorage } from '../types.js'

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
  // Deletes the namespace's sidecar and the snapshot it names, unless they
  // belong to a later namespace of the same name.
  remove(namespace: string, createdAt: number): Promise<void>
}

interface FileSystem {
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  writeFile(path: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
}

// Files live under `<dir>/<core key>/`, one sidecar per namespace naming the
// snapshot it describes. A snapshot gets a new file per revision and the
// sidecar is renamed into place after it, so a crash at any point leaves a
// sidecar that matches the file it names.
export function createSnapshotStore(dir: string, coreKey: string): SnapshotStore {
  const root = `${dir}/${coreKey}`
  let fs: Promise<FileSystem> | null = null

  function fileSystem(): Promise<FileSystem> {
    if (!fs) fs = import('bare-fs').then((module) => module.promises as unknown as FileSystem)
    return fs
  }

  function base(namespace: string): string {
    return qvacCrypto.createHash('sha256').update(namespace).digest('hex').slice(0, 32) as string
  }

  async function readSidecar(namespace: string): Promise<Sidecar | null> {
    const files = await fileSystem()
    try {
      return JSON.parse(await files.readFile(`${root}/${base(namespace)}.json`, 'utf8')) as Sidecar
    } catch {
      return null
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
      const files = await fileSystem()
      await files.mkdir(root, { recursive: true })
      const name = base(identity.namespace)
      const previous = await readSidecar(identity.namespace)
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
      await files.writeFile(`${sidecarPath}.tmp`, JSON.stringify(sidecar))
      await files.rename(`${sidecarPath}.tmp`, sidecarPath)

      if (previous && previous.file !== file && !previous.file.includes('/')) {
        await files.unlink(`${root}/${previous.file}`).catch(() => {})
      }
      return revision
    },

    async remove(namespace, createdAt) {
      const files = await fileSystem()
      const sidecar = await readSidecar(namespace)
      if (sidecar && sidecar.createdAt !== createdAt) return
      await files.unlink(`${root}/${base(namespace)}.json`).catch(() => {})
      if (sidecar && typeof sidecar.file === 'string' && !sidecar.file.includes('/')) {
        await files.unlink(`${root}/${sidecar.file}`).catch(() => {})
      }
    }
  }
}
