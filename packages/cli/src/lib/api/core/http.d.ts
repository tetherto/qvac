import type { QvacContext, QvacRequestModel } from '@/lib/api/core/context'
import type { ParsedFile } from '@/lib/api/lib/multipart'

declare module '@/lib/http' {
  interface HttpServer {
    qvac: QvacContext
  }
  interface HttpRequest {
    qvacModel?: QvacRequestModel
    bindCancel: (requestId: string) => void
    multipartFiles?: ParsedFile[]
  }
  interface HttpContextConfig {
    unsupportedParams?: string[]
    sseSentinel?: boolean
  }
}
