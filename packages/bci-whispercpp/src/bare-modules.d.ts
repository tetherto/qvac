declare module "bare-fs" {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string): Uint8Array;
}

declare module "bare-path" {
  export function join(...paths: string[]): string;
}
