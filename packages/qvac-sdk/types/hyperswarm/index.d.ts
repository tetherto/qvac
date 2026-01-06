declare module "hyperswarm" {
  import { EventEmitter } from "events";

  export interface SwarmOptions {
    seed?: Buffer;
    maxPeers?: number;
    maxServerSockets?: number;
    maxClientSockets?: number;
    firewall?: (
      remotePublicKey: Buffer,
      remoteHandshakePayload: unknown,
    ) => boolean;
    dht?: unknown;
    announce?: boolean;
    lookup?: boolean;
    preferredPort?: number;
    ephemeral?: boolean;
    bind?: string;
    socket?: unknown;
    keyPair?: {
      publicKey: Buffer;
      secretKey: Buffer;
    };
    relayThrough?: (force?: boolean) => Buffer[] | null;
  }

  export interface JoinOptions {
    server?: boolean;
    client?: boolean;
    announce?: boolean;
    lookup?: boolean;
  }

  export interface Connection extends EventEmitter {
    remotePublicKey: Buffer;
    handshakeHash: Buffer;
    destroyed: boolean;
    connecting: boolean;

    write(data: string | Buffer): boolean;
    destroy(error?: Error): void;
    end(): void;

    on(
      event: "open" | "close" | "error" | "timeout" | "data",
      listener: () => void,
    ): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "data", listener: (data: Buffer) => void): this;
  }

  export default class Hyperswarm extends EventEmitter {
    constructor(options?: SwarmOptions);

    publicKey: Buffer;
    keyPair: {
      publicKey: Buffer;
      secretKey: Buffer;
    };
    discovery: unknown;
    destroyed: boolean;
    suspended: boolean;
    connecting: number;

    join(
      topic: Buffer,
      options?: JoinOptions,
    ): {
      flushed(): Promise<void>;
      destroyed(): Promise<void>;
    };

    leave(topic: Buffer): void;

    flush(): Promise<void>;

    suspend(options?: { log?: (message: string) => void }): Promise<void>;

    resume(options?: { log?: (message: string) => void }): Promise<void>;

    destroy(): Promise<void>;

    on(event: "connection", listener: (connection: Connection) => void): this;
    on(event: "peer", listener: (peer: unknown) => void): this;
    on(event: "close" | "update", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;

    once(event: "connection", listener: (connection: Connection) => void): this;
    once(event: "peer", listener: (peer: unknown) => void): this;
    once(event: "close" | "update", listener: () => void): this;
    once(event: "error", listener: (error: Error) => void): this;
  }
}
