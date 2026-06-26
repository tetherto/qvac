declare module 'js-yaml' {
  export function load(input: string): unknown
  export function dump(obj: unknown, opts?: { lineWidth?: number }): string
}
