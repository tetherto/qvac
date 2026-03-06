declare module "pear-pipe" {
  import type { EventEmitter } from "events";

  interface PearPipe extends EventEmitter {
    autoexit: boolean;
    write(data: Buffer): boolean;
    end(data?: Buffer): void;
    destroy(err?: Error): void;
    on(event: "data", listener: (data: unknown) => void): this;
    on(event: "end", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    once(event: "data", listener: (data: unknown) => void): this;
    once(event: "end", listener: () => void): this;
    once(event: "error", listener: (err: Error) => void): this;
  }

  function pearPipe(): PearPipe | null;
  export = pearPipe;
}
