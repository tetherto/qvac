declare module "bare-path" {
  export function isAbsolute(path: string): boolean;
  export function join(...paths: string[]): string;
}
