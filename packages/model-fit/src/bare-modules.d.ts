// Bare's stdlib modules ship no type declarations. Declare only the surface
// this package actually uses, mirroring @qvac/embed-llamacpp/src/bare-modules.d.ts.

declare module 'bare-fs' {
  export function statSync (path: string): { isDirectory(): boolean }
}

declare module 'bare-path' {
  export function join (...paths: string[]): string
  export function dirname (path: string): string
  export function isAbsolute (path: string): boolean
}
