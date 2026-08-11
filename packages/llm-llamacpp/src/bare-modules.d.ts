// `bare-path` ships no type declarations; this is the surface the wrapper uses.
declare module "bare-path" {
  export function join(...paths: string[]): string;
  export function basename(path: string): string;
  export function isAbsolute(path: string): boolean;
}
