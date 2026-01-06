declare module "hyperdrive" {
  import type { EventEmitter } from "events";
  import type { Readable } from "stream";
  import type { Connection } from "hyperswarm";

  export interface HyperdriveOptions {
    extension?: boolean;
    keyPair?: {
      publicKey: Buffer;
      secretKey: Buffer;
    };
    sparse?: boolean;
    sparseMetadata?: boolean;
  }

  export interface HyperdriveBlob {
    blockOffset: number;
    blockLength: number;
    byteOffset: number;
    byteLength: number;
  }

  export interface Entry {
    key: string;
    value?: {
      blob?: HyperdriveBlob;
    };
  }

  export interface ReadStreamOptions {
    start?: number;
    end?: number;
    length?: number;
  }

  export interface Download {
    done(): Promise<void>;
    destroy(): void;
  }

  export interface Hypercore {
    get(index: number): Promise<Buffer | null>;
    length: number;
    update(): Promise<boolean>;
  }

  export interface entryOptions {
    follow?: boolean; // whether to follow symlinks
    wait?: boolean; // whether to wait for block to be downloaded
    timeout?: number; // wait at max some milliseconds (0 means no timeout)
  }

  export interface listOptions {
    recursive?: boolean; // whether to descend into all subfolders or not
    ignore?: string | string[]; // ignore files and folders by name
    wait?: boolean; // whether to wait for block to be downloaded
  }

  export default class Hyperdrive extends EventEmitter {
    constructor(corestore: unknown, key?: Buffer, options?: HyperdriveOptions);

    key: Buffer;
    discoveryKey: Buffer;
    writable: boolean;
    readable: boolean;
    core: Hypercore;

    ready(): Promise<void>;
    close(): Promise<void>;

    entry(path: string, options?: entryOptions): Promise<Entry | null>;
    list(path: string, options?: listOptions): AsyncIterableIterator<Entry>;
    download(path: string): Download;
    createReadStream(path: string, options?: ReadStreamOptions): Readable;
    // See https://docs.pears.com/building-blocks/hyperdrive#drive.findingpeers
    replicate(connection: Connection): void;
    findingPeers(): () => void;
    getBlobs(): Promise<{
      core: {
        on(
          event: "download",
          handler: (index: number, bytes: number) => void,
        ): void;
        off(
          event: "download",
          handler: (index: number, bytes: number) => void,
        ): void;
        has(index: number): Promise<boolean>;
      };
    }>;
  }
}
