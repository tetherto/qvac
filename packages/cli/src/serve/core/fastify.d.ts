import type { QvacContext, QvacRequestModel } from '@/serve/core/context'
import type { ParsedFile } from '@/serve/lib/multipart'

declare module 'fastify' {
  interface FastifyInstance {
    qvac: QvacContext
  }
  interface FastifyRequest {
    qvacModel?: QvacRequestModel
    bindCancel: (requestId: string) => void
    multipartFiles?: ParsedFile[]
  }
  interface FastifyContextConfig {
    unsupportedParams?: string[]
    sseSentinel?: boolean
    /** Answers `403 admin_disabled` unless the server was started with `--enable-admin`. */
    admin?: boolean
    /** Still served while the runtime is suspended. */
    allowWhileSuspended?: boolean
  }
}
