declare module "bare-fs" {
  export function existsSync(path: string): boolean;
}

declare module "bare-path" {
  export function join(...paths: string[]): string;
}
