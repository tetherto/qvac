declare module "corestore" {
  import { EventEmitter } from "events";

  export interface CorestoreOptions {
    primaryKey?: Buffer;
    sparse?: boolean;
    valueEncoding?: string;
    keyEncoding?: string;
    cacheSize?: number;
    stats?: boolean;
    extensions?: string[];
    createIfMissing?: boolean;
    overwrite?: boolean;
  }

  export interface Core {
    key: Buffer;
    discoveryKey: Buffer;
    length: number;
    byteLength: number;
    writable: boolean;
    readable: boolean;

    ready(): Promise<void>;
    close(): Promise<void>;
    get(index: number): Promise<Buffer | null>;
    append(data: Buffer): Promise<number>;
    download(range?: { start?: number; end?: number }): Promise<void>;
  }

  export default class Corestore extends EventEmitter {
    constructor(storage: string, options?: CorestoreOptions);

    ready(): Promise<void>;
    close(): Promise<void>;
    suspend(): Promise<void>;
    resume(): Promise<void>;

    get(key: Buffer): Core;
    namespace(name: string): Corestore;
  }
}
