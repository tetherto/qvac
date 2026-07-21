declare module "bare-fs" {
  export function readFileSync(path: string): Buffer;
}

declare module "bare-path" {
  export function join(...paths: string[]): string;
}
