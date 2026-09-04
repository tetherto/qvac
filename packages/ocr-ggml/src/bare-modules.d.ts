declare module "bare-fs" {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string): Buffer;
}

declare module "bare-path" {
  export function join(...paths: string[]): string;
  export function dirname(path: string): string;
}
