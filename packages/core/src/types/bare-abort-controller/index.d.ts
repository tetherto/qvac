// bare-abort-controller ships its own types, but they diverge structurally from
// the DOM `AbortController`/`AbortSignal` (e.g. no `onabort`) that the rest of
// the codebase and the standard libs use. This shim unifies them onto the global
// types so a bare-created controller flows into any DOM-typed API. Keep it until
// bare-abort-controller's own types are DOM-compatible.
declare module 'bare-abort-controller' {
  export const AbortController: {
    prototype: globalThis.AbortController
    new (): globalThis.AbortController
  }

  export const AbortSignal: {
    prototype: globalThis.AbortSignal
    new (): globalThis.AbortSignal
  }

  export type AbortController = globalThis.AbortController
  export type AbortSignal = globalThis.AbortSignal
}
