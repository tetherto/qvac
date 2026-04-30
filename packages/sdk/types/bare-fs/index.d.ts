declare module "bare-fs" {
  import { Readable, Writable } from "stream";

  export interface Stats {
    size: number;
    atime: Date;
    mtime: Date;
    ctime: Date;
    birthtime: Date;
    isFile(): boolean;
    isDirectory(): boolean;
    isBlockDevice(): boolean;
    isCharacterDevice(): boolean;
    isSymbolicLink(): boolean;
    isFIFO(): boolean;
    isSocket(): boolean;
  }

  export interface ReadStreamOptions {
    flags?: string;
    encoding?: BufferEncoding;
    fd?: number;
    mode?: number;
    autoClose?: boolean;
    start?: number;
    end?: number;
  }

  export interface WriteStreamOptions {
    flags?: string;
    encoding?: BufferEncoding;
    fd?: number;
    mode?: number;
    autoClose?: boolean;
    start?: number;
  }

  export class ReadStream extends Readable {
    constructor(path: string, options?: ReadStreamOptions);
    path: string;
    destroyed: boolean;
    destroy(error?: Error): this;
  }

  export class WriteStream extends Writable {
    constructor(path: string, options?: WriteStreamOptions);
    path: string;
    destroyed: boolean;
    destroy(error?: Error): this;
  }

  export function accessSync(path: string): void;
  export function statSync(path: string): Stats;
  export function readFileSync(
    path: string,
    encoding?: BufferEncoding,
  ): string | Buffer;
  export function writeFileSync(
    path: string,
    data: string | Buffer,
    encoding?: BufferEncoding,
  ): void;
  export function unlinkSync(path: string): void;
  export function mkdirSync(
    path: string,
    options?: { recursive?: boolean; mode?: number },
  ): void;
  export function rmdirSync(path: string): void;
  export function rmSync(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): void;
  export function readdirSync(
    path: string,
    options?: { encoding?: BufferEncoding; withFileTypes?: boolean },
  ): string[] | Buffer[];
  export function renameSync(oldPath: string, newPath: string): void;
  export function createReadStream(
    path: string,
    options?: ReadStreamOptions,
  ): ReadStream;
  export function createWriteStream(
    path: string,
    options?: WriteStreamOptions,
  ): WriteStream;
  export function existsSync(path: string): boolean;
  export const constants: {
    F_OK: number;
    R_OK: number;
    W_OK: number;
    X_OK: number;
  };

  export const promises: {
    access(path: string, mode?: number): Promise<void>;
    stat(path: string): Promise<Stats>;
    unlink(path: string): Promise<void>;
    rm(
      path: string,
      options?: { recursive?: boolean; force?: boolean },
    ): Promise<void>;
    readFile(path: string, encoding?: BufferEncoding): Promise<string | Buffer>;
    writeFile(
      path: string,
      data: string | Buffer,
      encoding?: BufferEncoding,
    ): Promise<void>;
    mkdir(
      path: string,
      options?: { recursive?: boolean; mode?: number },
    ): Promise<void>;
    rmdir(path: string): Promise<void>;
    readdir(
      path: string,
      options?: { encoding?: BufferEncoding; withFileTypes?: boolean },
    ): Promise<string[] | Buffer[]>;
    rename(oldPath: string, newPath: string): Promise<void>;
  };
}
