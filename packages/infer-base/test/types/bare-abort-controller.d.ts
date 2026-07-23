// bare-events exposes this optional peer type. The consumer fixture only
// needs its shape so TypeScript can fully validate infer-base declarations.
declare module 'bare-abort-controller' {
  export interface AbortSignal {
    readonly aborted: boolean
  }
}
