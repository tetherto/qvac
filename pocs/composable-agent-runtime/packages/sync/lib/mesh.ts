import Autobee, {
  type AutobeeHost,
  type AutobeeNode,
  type AutobeeView
} from 'autobee'
import Corestore from 'corestore'
import HyperDB from 'hyperdb'
import crypto from 'hypercore-crypto'
import ReadyResource from 'ready-resource'
import type { Duplex } from 'streamx'
import MeshDatabase from '../spec/mesh/hyperdb/index.js'
import { encode, Router } from '../spec/mesh/hyperdispatch/index.js'
import type {
  SyncAddWriterOperation,
  SyncApplyProfileOperation,
  SyncDevice,
  SyncProfileHead,
  SyncProfileOperation,
  SyncPutDeviceOperation,
  SyncRemoveWriterOperation,
  SyncRenameDeviceOperation
} from '../spec/mesh/hyperschema/types.d.ts'
import type { ProfileRegistry } from './profiles/profile-runtime.ts'

const [MESH_IDENTITY, MESH_ENCRYPTION] = crypto.namespace('qvac-sync/poc/mesh', 2)
const PROFILE_OPERATIONS = '@sync/profile-operations'
const PROFILE_HEADS = '@sync/profile-heads'
const DEVICES = '@sync/devices'

interface MeshView {
  readonly database: HyperDB
}

interface ApplyContext {
  readonly transaction: ReturnType<HyperDB['transaction']>
  readonly host: AutobeeHost
  readonly node: AutobeeNode
}

export interface MeshOptions {
  readonly seed: Buffer
  readonly key?: Buffer | null
  readonly writerKeyPair: { readonly publicKey: Buffer; readonly secretKey: Buffer }
  readonly profiles: ProfileRegistry
}

export class Mesh extends ReadyResource {
  private readonly store: Corestore
  private readonly seed: Buffer
  private readonly baseKey: Buffer | null
  private readonly writerKeyPair: {
    readonly publicKey: Buffer
    readonly secretKey: Buffer
  }
  private readonly profiles: ProfileRegistry
  private readonly router: Router
  private keyPair!: { readonly publicKey: Buffer; readonly secretKey: Buffer }
  private encryptionKey!: Buffer
  autobee!: Autobee<MeshView>
  discoveryKey!: Buffer

  constructor(store: Corestore, options: MeshOptions) {
    super()
    this.store = store
    this.seed = options.seed
    this.baseKey = options.key ?? null
    this.writerKeyPair = options.writerKeyPair
    this.profiles = options.profiles
    this.router = new Router()
    this.router.add(
      '@sync/add-writer',
      ({ key }: SyncAddWriterOperation, context: ApplyContext) => {
        context.host.addWriter(key, { isIndexer: false })
      }
    )
    this.router.add(
      '@sync/put-device',
      async ({ device }: SyncPutDeviceOperation, context: ApplyContext) => {
        const existing = await context.transaction.get<SyncDevice>(DEVICES, {
          id: device.id
        })
        if (existing?.revokedAt) return
        await context.transaction.insert<SyncDevice>(DEVICES, existing ?? device)
      }
    )
    this.router.add(
      '@sync/rename-device',
      async ({ id, name }: SyncRenameDeviceOperation, context: ApplyContext) => {
        const existing = await context.transaction.get<SyncDevice>(DEVICES, { id })
        if (!existing || existing.revokedAt) return
        await context.transaction.insert<SyncDevice>(DEVICES, { ...existing, name })
      }
    )
    this.router.add(
      '@sync/remove-writer',
      async (
        { id, writerKey, revokedAt }: SyncRemoveWriterOperation,
        context: ApplyContext
      ) => {
        const existing = await context.transaction.get<SyncDevice>(DEVICES, { id })
        if (!existing || existing.revokedAt) return
        ;(
          context.host as AutobeeHost & {
            removeWriter(key: Buffer): void
          }
        ).removeWriter(writerKey)
        await context.transaction.insert<SyncDevice>(DEVICES, {
          ...existing,
          revokedAt
        })
      }
    )
    this.router.add(
      '@sync/apply-profile',
      async (operation: SyncApplyProfileOperation, context: ApplyContext) => {
        const existing = await context.transaction.get<SyncProfileOperation>(
          PROFILE_OPERATIONS,
          { id: operation.operationId }
        )
        if (existing) return
        if (operation.expectedRevision != null) {
          const head = await context.transaction.get<SyncProfileHead>(
            PROFILE_HEADS,
            { id: operation.profileId }
          )
          if (head?.revision !== operation.expectedRevision) return
        }
        const profile = this.profiles.require(operation.profileId)
        const accepted = await profile.apply(operation.command, {
          transaction: context.transaction,
          deviceId: operation.deviceId,
          recordedAt: operation.recordedAt,
          expectedRevision: operation.expectedRevision ?? undefined,
          revision: operation.revision
        })
        if (!accepted) return
        await context.transaction.insert<SyncProfileOperation>(
          PROFILE_OPERATIONS,
          {
            id: operation.operationId,
            profileId: operation.profileId,
            revision: operation.revision,
            command: operation.inputCommand
          }
        )
        await context.transaction.insert<SyncProfileHead>(PROFILE_HEADS, {
          id: operation.profileId,
          revision: operation.revision
        })
      }
    )
  }

  get key() {
    return this.autobee.key
  }

  get writable() {
    return this.autobee.writable
  }

  get pairingSeed() {
    return this.seed
  }

  get view() {
    return this.autobee.view.database
  }

  async _open() {
    this.keyPair = crypto.keyPair(crypto.hash([MESH_IDENTITY, this.seed]))
    this.encryptionKey = crypto.hash([MESH_ENCRYPTION, this.seed])
    const namespaceKey = crypto.discoveryKey(this.keyPair.publicKey)
    const namespace = this.store.namespace(namespaceKey)
    this.autobee = new Autobee(namespace, this.baseKey, {
      open: this.openView.bind(this),
      apply: this.apply.bind(this),
      keyPair: this.writerKeyPair,
      encrypted: true,
      encryptionKey: this.encryptionKey
    })
    try {
      await this.autobee.ready()
    } catch (error) {
      await Promise.allSettled([this.autobee.close()])
      throw error
    }
    this.discoveryKey = this.autobee.discoveryKey
  }

  async _close() {
    if (this.opened) await this.autobee.close()
  }

  async addWriter(key: Buffer) {
    if (!this.writable) throw new Error('This sync peer is read-only')
    const encoded = encode('@sync/add-writer', { key })
    if (!encoded) throw new Error('Could not encode writer admission operation')
    await this.autobee.append(encoded)
    await this.autobee.update()
  }

  get localWriterKey() {
    return this.writerKeyPair.publicKey
  }

  async putDevice(device: SyncDevice) {
    const encoded = encode('@sync/put-device', { device })
    if (!encoded) throw new Error('Could not encode device operation')
    await this.autobee.append(encoded)
    await this.autobee.update()
  }

  async renameDevice(id: Buffer, name: string) {
    const encoded = encode('@sync/rename-device', { id, name })
    if (!encoded) throw new Error('Could not encode device rename operation')
    await this.autobee.append(encoded)
    await this.autobee.update()
  }

  async removeDevice(id: Buffer, writerKey: Buffer) {
    const encoded = encode('@sync/remove-writer', {
      id,
      writerKey,
      revokedAt: Date.now()
    })
    if (!encoded) throw new Error('Could not encode device removal operation')
    await this.autobee.append(encoded)
    await this.autobee.update()
  }

  async listDevices() {
    return this.view.find<SyncDevice>(DEVICES).toArray()
  }

  async applyProfile(input: {
    readonly profileId: string
    readonly version: number
    readonly operationId: string
    readonly expectedRevision?: string
    readonly command: Buffer
    readonly deviceId: Buffer
    readonly recordedAt: number
  }) {
    const profile = this.profiles.require(input.profileId, input.version)
    const existing = await this.view.get<SyncProfileOperation>(
      PROFILE_OPERATIONS,
      { id: input.operationId }
    )
    if (existing) {
      if (existing.profileId !== input.profileId) {
        throw new Error(
          `Profile operationId ${input.operationId} belongs to ${existing.profileId}`
        )
      }
      if (!sameBuffer(existing.command, input.command)) {
        throw new Error(
          `Profile operationId ${input.operationId} was reused with a different command`
        )
      }
      return { revision: existing.revision }
    }
    if (input.expectedRevision != null) {
      const head = await this.view.get<SyncProfileHead>(PROFILE_HEADS, {
        id: input.profileId
      })
      if (head?.revision !== input.expectedRevision) {
        throw new Error(
          `Sync profile revision conflict: expected ${input.expectedRevision}, got ${head?.revision ?? 'none'}`
        )
      }
    }
    if (!this.writable) throw new Error('This sync peer is read-only')
    const revision = input.operationId
    const command = profile.prepare(input.command, {
      deviceId: input.deviceId,
      recordedAt: input.recordedAt
    })
    const encoded = encode('@sync/apply-profile', {
      profileId: input.profileId,
      operationId: input.operationId,
      revision,
      expectedRevision: input.expectedRevision,
      command,
      inputCommand: input.command,
      deviceId: input.deviceId,
      recordedAt: input.recordedAt
    })
    if (!encoded) throw new Error('Could not encode profile operation')
    await this.autobee.append(encoded)
    await this.autobee.update()
    const applied = await this.view.get<SyncProfileOperation>(
      PROFILE_OPERATIONS,
      { id: input.operationId }
    )
    if (!applied) {
      const head = await this.view.get<SyncProfileHead>(PROFILE_HEADS, {
        id: input.profileId
      })
      if (
        input.expectedRevision == null ||
        head?.revision === input.expectedRevision
      ) {
        throw new Error(
          `Invalid Sync profile transition for operation ${input.operationId}`
        )
      }
      throw new Error(
        `Sync profile revision conflict: expected ${input.expectedRevision ?? 'none'}, got ${head?.revision ?? 'none'}`
      )
    }
    return { revision }
  }

  async queryProfile(input: {
    readonly profileId: string
    readonly version: number
    readonly query: Buffer
  }) {
    const profile = this.profiles.require(input.profileId, input.version)
    return profile.query(input.query, this.view)
  }

  async profileRevision(profileId: string) {
    const head = await this.view.get<SyncProfileHead>(PROFILE_HEADS, {
      id: profileId
    })
    return head?.revision ?? null
  }

  async waitForWritable(timeoutMs = 30_000) {
    if (this.writable) return
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error('Writer admission did not replicate before timeout'))
      }, timeoutMs)
      const onWritable = () => {
        cleanup()
        resolve()
      }
      const cleanup = () => {
        clearTimeout(timeout)
        this.autobee.removeListener('writable', onWritable)
      }
      this.autobee.once('writable', onWritable)
      if (this.writable) onWritable()
    })
  }

  replicate(stream: Duplex) {
    this.autobee.replicate(stream)
    void this.autobee.update()
  }

  watch(listener: () => void) {
    this.view.watch(listener)
  }

  unwatch(listener: () => void) {
    this.view.unwatch(listener)
  }

  private openView(bee: AutobeeView): MeshView {
    return { database: HyperDB.bee2(bee, MeshDatabase, { autoUpdate: true }) }
  }

  private async apply(
    nodes: ReadonlyArray<AutobeeNode>,
    view: MeshView,
    host: AutobeeHost
  ) {
    const transaction = view.database.transaction()
    try {
      for (const node of nodes) {
        if (!node.value) continue
        await this.router.dispatch(node.value, { transaction, host, node })
      }
    } catch (error) {
      await transaction.close()
      throw error
    }
    await transaction.flush()
  }
}

function sameBuffer(left: Buffer, right: Buffer) {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}
