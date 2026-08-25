/// <reference types="bare" />
/// <reference types="bare-abort-controller/global" />

// Bare (and Node) provide `import.meta.url` at runtime, but it is not in the
// ES2022 lib and no `@types/node` is pulled in, so declare it here.
declare global {
  interface ImportMeta {
    readonly url: string
  }
}

export {}
