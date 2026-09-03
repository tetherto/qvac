declare module "bare-fs" {
  export function existsSync(path: string): boolean;
  export function openSync(
    path: string,
    flags?: string | number,
    mode?: string | number,
  ): number;
  export function readSync(
    fd: number,
    buffer: Uint8Array,
    offset?: number,
    len?: number,
    pos?: number,
  ): number;
  export function closeSync(fd: number): void;
}

declare module "bare-path" {
  export function join(...paths: string[]): string;
  export function dirname(path: string): string;
}

declare const __dirname: string;
declare function require(id: string): unknown;
declare namespace require {
  const addon: { host: string } | undefined;
  function resolve(id: string): string;
}
declare const module: { exports: unknown };
