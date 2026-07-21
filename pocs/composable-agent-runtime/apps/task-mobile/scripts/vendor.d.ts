declare module 'bare-pack/fs' {
  export function readModule(url: import('bare-url')): Promise<string | null>

  export function listPrefix(
    prefix: import('bare-url')
  ): AsyncIterable<import('bare-url')>
}

declare module 'bare-link' {
  interface LinkOptions {
    hosts: string[]
    out: string
  }

  interface LinkPackage {
    name: string
    version: string
    dependencies: Record<string, string>
  }

  export default function link(
    root: string,
    options: LinkOptions,
    pkg?: LinkPackage
  ): AsyncIterable<unknown>
}
