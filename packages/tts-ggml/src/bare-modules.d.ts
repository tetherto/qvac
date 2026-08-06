declare module "bare-fs" {
  export function existsSync(path: string): boolean;
  export function readdirSync(path: string): string[];
}

declare module "bare-os" {
  export function platform(): string;
}

declare module "bare-path" {
  export function join(...paths: string[]): string;
}

declare const __dirname: string;
declare function require(id: string): unknown;
declare const module: { exports: unknown };
