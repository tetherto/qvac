declare module "bare-fs" {
  export function existsSync(path: string): boolean;
  export function readdirSync(path: string): string[];
}

declare module "bare-os" {
  export function platform(): string;
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
