import qvacCrypto from '#crypto'

import type { IndexStorage } from '../types.js'
import type { NativeIndex } from './native.js'

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

export interface SnapshotStore {
  read(identity: SnapshotIdentity): Promise<StoredSnapshot | null>
  // `revision` is read right before the synchronous native write, so the file
  // and its sidecar always describe the same state. Returns that revision.
  write(identity: SnapshotIdentity, index: NativeIndex, revision: () => number): Promise<number>
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

    async write(identity, index, current) {
      const files = await fileSystem()
      await files.mkdir(root, { recursive: true })
      const name = base(identity.namespace)
      const previous = await readSidecar(identity.namespace)
      const revision = current()
      const file = `${name}.${revision}.tvec`
      index.write(`${root}/${file}`)

      const sidecar: Sidecar = { version: 1, ...identity, revision, file }
      const sidecarPath = `${root}/${name}.json`
      await files.writeFile(`${sidecarPath}.tmp`, JSON.stringify(sidecar))
      await files.rename(`${sidecarPath}.tmp`, sidecarPath)

      if (previous && previous.file !== file && !previous.file.includes('/')) {
        await files.unlink(`${root}/${previous.file}`).catch(() => {})
      }
      return revision
    }
  }
}
