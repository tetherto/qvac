declare module "bare-net" {
  import { EventEmitter } from "events";
  import { Duplex } from "stream";

  export interface ServerOptions {
    allowHalfOpen?: boolean;
    pauseOnConnect?: boolean;
  }

  export interface SocketOptions {
    fd?: number;
    allowHalfOpen?: boolean;
    readable?: boolean;
    writable?: boolean;
  }

  export class Socket extends Duplex {
    constructor(options?: SocketOptions);

    remoteAddress?: string;
    remotePort?: number;
    localAddress?: string;
    localPort?: number;
    connecting: boolean;
    destroyed: boolean;

    connect(port: number, host?: string): this;
    connect(options: {
      port: number;
      host?: string;
      localAddress?: string;
      localPort?: number;
    }): this;
    destroy(error?: Error): this;
    end(data?: string | Buffer): this;
    setTimeout(timeout: number, callback?: () => void): this;
    setNoDelay(noDelay?: boolean): this;
    setKeepAlive(enable?: boolean, initialDelay?: number): this;

    on(event: "connect" | "close" | "timeout", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "data", listener: (data: Buffer) => void): this;
  }

  export class Server extends EventEmitter {
    constructor(
      options?: ServerOptions,
      connectionListener?: (socket: Socket) => void,
    );
    constructor(connectionListener?: (socket: Socket) => void);

    listening: boolean;
    maxConnections?: number;

    listen(
      port?: number,
      host?: string,
      backlog?: number,
      listeningListener?: () => void,
    ): this;
    listen(
      options: { port?: number; host?: string; backlog?: number },
      listeningListener?: () => void,
    ): this;
    listen(path: string, listeningListener?: () => void): this;
    close(callback?: (error?: Error) => void): this;
    address(): { address: string; family: string; port: number } | null;

    on(event: "connection", listener: (socket: Socket) => void): this;
    on(event: "listening" | "close", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
  }

  export function createServer(
    options?: ServerOptions,
    connectionListener?: (socket: Socket) => void,
  ): Server;
  export function createServer(
    connectionListener?: (socket: Socket) => void,
  ): Server;
  export function createConnection(
    options: { port: number; host?: string },
    connectionListener?: () => void,
  ): Socket;
  export function createConnection(
    port: number,
    host?: string,
    connectionListener?: () => void,
  ): Socket;
  export function connect(path: string): Socket;
}
