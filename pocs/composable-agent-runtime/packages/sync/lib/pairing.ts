import BlindPairing from 'blind-pairing'
import type Hyperswarm from 'hyperswarm'
import type {
  RpcCreatePairingInviteRequest,
  RpcPairingInvite,
  RpcPairingRequest
} from '../spec/rpc/hyperschema/types.d.ts'
import type { Mesh } from './mesh.ts'

const DEFAULT_INVITE_TTL_MS = 5 * 60 * 1_000
const MAX_INVITE_TTL_MS = 24 * 60 * 60 * 1_000

interface PairingMemberRequest {
  readonly inviteId: Buffer
  readonly id: Buffer
  readonly userData: Buffer
  open(publicKey: Buffer): Buffer
  confirm(options: {
    readonly key: Buffer
    readonly encryptionKey: Buffer
  }): void
  deny(options?: { readonly status?: number }): void
}

interface PairingMember {
  ready(): Promise<void>
  flushed(): Promise<void>
  close(): Promise<void>
}

interface InviteState {
  readonly publicKey: Buffer
  readonly member: PairingMember
  readonly expiresAt: number
  used: boolean
}

interface PendingRequest {
  readonly value: RpcPairingRequest
  readonly request: PairingMemberRequest
  resolve(decision: 'approved' | 'rejected'): void
}

export interface PairingResult {
  readonly meshKey: Buffer
  readonly meshSeed: Buffer
}

export class PairingCoordinator {
  private readonly mesh: Mesh
  private readonly pairing: BlindPairing
  private readonly invites = new Map<string, InviteState>()
  private readonly requests = new Map<string, PendingRequest>()
  private readonly listeners = new Set<() => void>()

  constructor(swarm: Hyperswarm, mesh: Mesh) {
    this.mesh = mesh
    this.pairing = new BlindPairing(swarm)
  }

  async createInvite(options: RpcCreatePairingInviteRequest): Promise<RpcPairingInvite> {
    if (!this.mesh.writable) throw new Error('Only a writable host can create pairing invites')
    const expiresInMs =
      options.expiresInMs == null || options.expiresInMs === 0
        ? DEFAULT_INVITE_TTL_MS
        : options.expiresInMs
    if (
      !Number.isSafeInteger(expiresInMs) ||
      expiresInMs < 1_000 ||
      expiresInMs > MAX_INVITE_TTL_MS
    ) {
      throw new Error('Pairing invite expiration must be between 1000 and 86400000 ms')
    }
    const expiresAt = Math.ceil((Date.now() + expiresInMs) / 1_000) * 1_000
    const created = BlindPairing.createInvite(this.mesh.key, { expires: expiresAt })
    const state: InviteState = {
      publicKey: created.publicKey,
      member: this.pairing.addMember({
        discoveryKey: created.discoveryKey,
        onadd: (request: PairingMemberRequest) => this.onRequest(request)
      }),
      expiresAt,
      used: false
    }
    this.invites.set(created.id.toString('hex'), state)
    await state.member.ready()
    await state.member.flushed()
    return { id: created.id, invite: created.invite, expiresAt }
  }

  listRequests() {
    return [...this.requests.values()].map(({ value }) => value)
  }

  async approve(id: Buffer) {
    const pending = this.requirePending(id)
    await this.mesh.addWriter(pending.value.writerKey)
    pending.value.status = 'approved'
    pending.resolve('approved')
    this.notify()
    return pending.value
  }

  reject(id: Buffer) {
    const pending = this.requirePending(id)
    pending.value.status = 'rejected'
    pending.resolve('rejected')
    this.notify()
    return pending.value
  }

  watch(listener: () => void) {
    this.listeners.add(listener)
  }

  unwatch(listener: () => void) {
    this.listeners.delete(listener)
  }

  async close() {
    this.listeners.clear()
    for (const pending of this.requests.values()) {
      if (pending.value.status !== 'pending') continue
      pending.value.status = 'rejected'
      pending.resolve('rejected')
    }
    for (const invite of this.invites.values()) await invite.member.close()
    this.invites.clear()
    await this.pairing.close()
  }

  private async onRequest(request: PairingMemberRequest) {
    const invite = this.invites.get(request.inviteId.toString('hex'))
    if (!invite) return

    try {
      request.open(invite.publicKey)
    } catch {
      request.deny()
      return
    }
    if (Date.now() >= invite.expiresAt) {
      request.deny({ status: 3 })
      return
    }
    if (invite.used) {
      request.deny({ status: 2 })
      return
    }

    invite.used = true
    const decision = new Promise<'approved' | 'rejected'>((resolve) => {
      const value: RpcPairingRequest = {
        id: request.id,
        writerKey: request.userData,
        fingerprint: fingerprint(request.userData),
        status: 'pending'
      }
      this.requests.set(request.id.toString('hex'), { value, request, resolve })
    })
    this.notify()

    if ((await decision) === 'rejected') {
      request.deny()
      return
    }
    request.confirm({
      key: this.mesh.key,
      encryptionKey: this.mesh.pairingSeed
    })
  }

  private requirePending(id: Buffer) {
    const pending = this.requests.get(id.toString('hex'))
    if (!pending) throw new Error('Pairing request not found')
    if (pending.value.status !== 'pending') {
      throw new Error(`Pairing request is already ${pending.value.status}`)
    }
    return pending
  }

  private notify() {
    for (const listener of this.listeners) listener()
  }
}

export async function pairWithHost(
  swarm: Hyperswarm,
  invite: Buffer,
  writerKey: Buffer
): Promise<PairingResult> {
  const decoded = decodeInvite(invite)
  if (decoded.expires !== 0 && decoded.expires <= Date.now()) {
    throw new Error('Pairing invite has expired')
  }
  const pairing = new BlindPairing(swarm)
  try {
    return await new Promise<PairingResult>((resolve, reject) => {
      const candidate = pairing.addCandidate({
        invite,
        userData: writerKey,
        onadd: (result: { readonly key: Buffer; readonly encryptionKey: Buffer }) => {
          resolve({ meshKey: result.key, meshSeed: result.encryptionKey })
        }
      })
      candidate.request.once('rejected', (error) => reject(normalizePairingError(error)))
    })
  } finally {
    await pairing.close()
  }
}

function decodeInvite(invite: Buffer) {
  try {
    return BlindPairing.decodeInvite(invite)
  } catch {
    throw new Error('Pairing invite is invalid')
  }
}

function normalizePairingError(error: Error & { readonly code?: string }) {
  if (error.code === 'INVITE_EXPIRED') return new Error('Pairing invite has expired')
  if (error.code === 'INVITE_USED') return new Error('Pairing invite has already been used')
  if (error.code === 'PAIRING_REJECTED') return new Error('Pairing request was rejected')
  return new Error('Pairing request failed')
}

function fingerprint(writerKey: Buffer) {
  const hex = writerKey.toString('hex')
  return `${hex.slice(0, 12)}:${hex.slice(-12)}`
}
