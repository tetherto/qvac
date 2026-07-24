declare module "bare-env" {
  const env: Record<string, string | undefined>;
  export = env;
}

declare module "bare-fs" {
  export function existsSync(path: string): boolean;
}

declare module "bare-path" {
  export function join(...paths: string[]): string;
  export function dirname(path: string): string;
}

