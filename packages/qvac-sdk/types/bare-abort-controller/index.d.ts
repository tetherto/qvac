declare module "bare-abort-controller" {
  export const AbortController: {
    prototype: globalThis.AbortController;
    new (): globalThis.AbortController;
  };

  export const AbortSignal: {
    prototype: globalThis.AbortSignal;
    new (): globalThis.AbortSignal;
  };

  export type AbortController = globalThis.AbortController;
  export type AbortSignal = globalThis.AbortSignal;
}
