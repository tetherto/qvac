interface ManagedWatch {
  on(event: string, listener: (...args: never[]) => void): unknown
  once(event: string, listener: (...args: never[]) => void): unknown
  removeListener(event: string, listener: (...args: never[]) => void): unknown
  destroy(): void
}
import type { Capabilities } from '@qvac/core/client'
type WatchMethod = 'projectsWatch' | 'chatsWatch' | 'knowledgeBaseWatch'
interface ProjectScope {
  workspaceMeshId: string
  projectMeshId: string
}
export type ProjectEvent = { type: string; value?: unknown; source?: string; error?: unknown }
export class ProjectSession {
  #client: Capabilities
  #generation = 0
  #dispose: Array<() => void> = []
  #scope: ProjectScope | null = null

  constructor(client: Capabilities) {
    this.#client = client
  }

  select({ workspaceMeshId, projectMeshId }: ProjectScope, emit: (event: ProjectEvent) => void) {
    if (!workspaceMeshId || !projectMeshId || workspaceMeshId === projectMeshId) {
      throw new Error('Select a workspace and a distinct project mesh.')
    }

    this.close()
    this.#scope = { workspaceMeshId, projectMeshId }
    try {
      this.#watch({ method: 'projectsWatch', meshId: workspaceMeshId, type: 'projects' }, emit)
      this.#watch({ method: 'chatsWatch', meshId: projectMeshId, type: 'chats' }, emit)
      this.#watch({ method: 'knowledgeBaseWatch', meshId: projectMeshId, type: 'knowledge' }, emit)
    } catch (error) {
      this.close()
      throw error
    }
  }

  #watch(
    { method, meshId, type }: { method: WatchMethod; meshId: string; type: string },
    emit: (event: ProjectEvent) => void
  ) {
    const generation = this.#generation
    const current = () => generation === this.#generation
    const stream = this.#client[method]({ meshId }) as unknown as ManagedWatch
    const deliver = (value: unknown) => {
      if (current()) {
        emit({ type, value })
      }
    }
    const failed = (error: unknown) => {
      if (current()) {
        emit({ type: 'error', source: type, error })
      }
    }
    const ended = () => {
      if (current()) {
        emit({ type: 'ended', source: type })
      }
    }
    stream.on('data', deliver)
    stream.on('error', failed)
    stream.on('end', ended)
    this.#dispose.push(() => {
      stream.removeListener('data', deliver)
      stream.removeListener('end', ended)
      // Keep the guarded error listener until close; destroy may report asynchronously.
      stream.once('close', () => stream.removeListener('error', failed))
      stream.destroy()
    })
  }

  send({ chatId, agentId, text }: { chatId?: string; agentId?: string; text: string }) {
    if (!this.#scope) throw new Error('Select a project before sending.')
    if (!text?.trim()) throw new Error('A message cannot be empty.')
    if (!chatId && !agentId) {
      throw new Error('A new chat needs an agent.')
    }

    return this.#client.sendMessage({
      meshId: this.#scope.projectMeshId,
      chatId: chatId ?? null,
      agentId: agentId ?? null,
      text
    })
  }

  close() {
    this.#generation++
    this.#scope = null
    const disposers = this.#dispose.splice(0)
    const errors = []
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (error) {
        errors.push(error)
      }
    }

    if (errors.length) {
      throw new AggregateError(errors, 'Project watches failed to close')
    }
  }
}
