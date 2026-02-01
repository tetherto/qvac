declare module "bare-path" {
  export interface PathObject {
    dir?: string;
    root?: string;
    base?: string;
    name?: string;
    ext?: string;
  }

  export function normalize(path: string): string;
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
  export function isAbsolute(path: string): boolean;
  export function relative(from: string, to: string): string;
  export function dirname(path: string): string;
  export function basename(path: string, ext?: string): string;
  export function extname(path: string): string;
  export function format(pathObject: PathObject): string;
  export function parse(path: string): PathObject;
  export const sep: string;
  export const delimiter: string;
  export const win32: unknown;
  export const posix: unknown;
}
