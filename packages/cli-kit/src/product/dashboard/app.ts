import type {
  Command,
  Connection,
  MouseMessage,
  RpcResult,
  Tui,
  ProductOptions
} from '../app-types.js'
import { Shell } from '../shell.js'
import { plain } from '../theme.js'
import { FORMS, SETUP_PAGES } from '../onboarding/pages.js'
import { RECEIVERS } from './receive.js'

// The chat beside the dashboard, where a product has one: what the shared pages link to.
export interface ChatLinks {
  chats: NonNullable<RpcResult<'listChats'>['chats']>
  chatId: string | null
  editor: { set(text: string): void }
  tabHint(): string
  useModel(name: string): Command
}

// The dashboard every product has: setup, the shared pages and their state. A product composes
// the page tables, adds its own pages, and names the chat beside them if it has one.
export abstract class Dashboard extends Shell {
  chat: ChatLinks | null
  invitation: (RpcResult<'meshInvite'> & { member?: boolean }) | null
  joinPreview: RpcResult<'previewMeshInvite'> | null
  cancelJoin: () => void
  setupNames: { account: string; device: string }
  configureDevice: () => Promise<void>
  removeUsers: NonNullable<RpcResult<'modelUsers'>['agents']>
  catalog: NonNullable<RpcResult<'listModels'>['models']> | null
  selection: number
  choice: number
  form: string
  accountName: string
  showQr: boolean
  joinValue: string
  removeName: string

  constructor(tui: Tui, options: ProductOptions = {}) {
    super(tui, options)
    this.chat = null
    this.selection = 0
    this.choice = 0
    this.form = ''
    this.accountName = ''
    this.invitation = null
    this.showQr = false
    this.joinPreview = null
    this.joinValue = ''
    this.cancelJoin = () => {}
    this.setupNames = { account: '', device: '' }
    this.configureDevice = async () => {}
    this.removeName = ''
    this.removeUsers = []
    this.catalog = null
  }

  override connected(conn: Partial<Connection>): Command {
    this.setupNames = conn.setupNames || this.setupNames
    this.configureDevice = conn.configure || this.configureDevice
    return super.connected(conn)
  }

  override snapshotTaken(): Command {
    const choices = pageChoices(this)
    if (choices) {
      this.selection = Math.min(this.selection, Math.max(0, choices.length - 1))
    }

    const first = !this.ready
    super.snapshotTaken()
    if (first && !this.product!.config?.onboardingCompleted && !this.options.skipSetup) {
      this.page = 'welcome'
    }

    return null
  }

  showInvite({ member = false } = {}) {
    return this.action(
      async () => ({
        ...(await this.engine!.meshInvite(
          member ? { member: true, meshId: this.product?.workspace?.meshId || this.meshId! } : {}
        )),
        member
      }),
      'product.invite'
    )
  }

  finishOnboarding(): Command {
    return this.action(async () => {
      const config = await this.engine!.getConfig({})
      await this.engine!.setConfig({ ...config, onboardingCompleted: true })
    }, 'product.finished')
  }

  // First-run setup keeps Esc as "back a step"; everywhere else it is the way home.
  inSetup() {
    if (SETUP_PAGES.has(this.page)) {
      return true
    }

    return this.page === 'invite' && !this.product?.config?.onboardingCompleted
  }

  // what the help page lists: the product's keys and commands
  abstract helpLines(): string[]

  override receive(msg: { type: string }): Command {
    const handle = RECEIVERS.get(msg.type)
    return handle ? handle(this, msg as never) : super.receive(msg)
  }

  override pasted(text: string): void {
    if (FORMS.includes(this.page)) {
      this.form += plain(text).replace(/\s+/g, ' ')
    } else {
      super.pasted(text)
    }
  }

  override wheel(msg: MouseMessage): Command {
    if (!['models', 'catalog'].includes(this.page)) {
      return super.wheel(msg)
    }

    const step = msg.button === 'wheelup' ? -1 : 1
    const n = (this.page === 'catalog' ? this.catalog : this.product?.models)?.length || 0
    if (n) {
      this.selection = Math.min(n - 1, Math.max(0, this.selection + step))
    }

    return null
  }
}

function pageChoices(app: Dashboard) {
  if (app.page === 'workspaces') {
    return app.product!.meshes.filter((m) => m.workspace)
  }

  if (app.page === 'catalog') {
    return app.catalog || []
  }

  return app.page === 'models' ? app.product!.models : null
}
