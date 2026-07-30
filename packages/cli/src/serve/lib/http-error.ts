export class HttpError extends Error {
  public readonly status: number
  public readonly code: string
  public readonly sseSentinel: boolean

  constructor(status: number, code: string, message: string, opts?: { sseSentinel?: boolean }) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.sseSentinel = opts?.sseSentinel ?? true
  }
}

export function errorType(status: number): string {
  return status >= 500 ? 'server_error' : 'invalid_request_error'
}
