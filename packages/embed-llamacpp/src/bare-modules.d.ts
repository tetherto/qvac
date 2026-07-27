declare module "bare-fs" {
  export function createReadStream(path: string): AsyncIterable<Buffer>;
}

declare module "bare-path" {
  export function join(...paths: string[]): string;
  export function basename(path: string): string;
  export function isAbsolute(path: string): boolean;
}
