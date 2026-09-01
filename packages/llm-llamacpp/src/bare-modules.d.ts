// `bare-path` ships no type declarations; this is the surface the wrapper uses.
declare module "bare-path" {
  export function join(...paths: string[]): string;
  export function basename(path: string): string;
  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
}

// Bare's `require` carries an `addon` surface that @types/node's NodeJS.Require
// does not model. Only the part resolveBackendsDir() in addon.ts needs.
// `resolve` is intentionally `unknown` (matching bare-module's own typing) so
// callers must narrow it.
declare namespace NodeJS {
  interface Require {
    addon: {
      (specifier?: string): unknown;
      resolve(specifier: string): unknown;
    };
  }
}
