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
  SyncPutTaskOperation,
  SyncTask
} from '../spec/mesh/hyperschema/types.d.ts'

const [MESH_IDENTITY, MESH_ENCRYPTION] = crypto.namespace('qvac-sync/poc/mesh', 2)
const TASKS = '@sync/tasks'

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
}

export class Mesh extends ReadyResource {
  private readonly store: Corestore
  private readonly seed: Buffer
  private readonly baseKey: Buffer | null
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
    this.router = new Router()
    this.router.add(
      '@sync/put-task',
      async ({ task }: SyncPutTaskOperation, context: ApplyContext) => {
        const existing = await context.transaction.get<SyncTask>(TASKS, { id: task.id })
        if (existing && task.updatedAt < existing.updatedAt) return
        if (existing && !existing.originDeviceId.equals(task.originDeviceId)) return
        await context.transaction.insert<SyncTask>(TASKS, task)
      }
    )
  }

  get key() {
    return this.autobee.key
  }

  get writable() {
    return this.autobee.writable
  }

  get view() {
    return this.autobee.view.database
  }

  async _open() {
    this.keyPair = crypto.keyPair(crypto.hash([MESH_IDENTITY, this.seed]))
    this.encryptionKey = crypto.hash([MESH_ENCRYPTION, this.seed])
    this.discoveryKey = crypto.discoveryKey(this.keyPair.publicKey)
    const namespace = this.store.namespace(this.discoveryKey)
    const writerKeyPair = await namespace.createKeyPair('local')
    this.autobee = new Autobee(namespace, this.baseKey, {
      open: this.openView.bind(this),
      apply: this.apply.bind(this),
      keyPair: writerKeyPair,
      encrypted: true,
      encryptionKey: this.encryptionKey
    })
    await this.autobee.ready()
  }

  async _close() {
    if (this.opened) await this.autobee.close()
  }

  async dispatch(task: SyncTask) {
    if (!this.writable) throw new Error('This sync peer is read-only')
    const encoded = encode('@sync/put-task', { task })
    if (!encoded) throw new Error('Could not encode task operation')
    await this.autobee.append(encoded)
    await this.autobee.update()
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
