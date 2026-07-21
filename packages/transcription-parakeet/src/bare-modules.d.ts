declare module "bare-fs" {
  export function existsSync(path: string): boolean;
}

declare module "bare-path" {
  export function join(...paths: string[]): string;
}

declare module "stream" {
  export type Readable = AsyncIterable<Uint8Array>;
}

declare const __dirname: string;
declare function require(id: string): unknown;
declare const module: { exports: unknown };
