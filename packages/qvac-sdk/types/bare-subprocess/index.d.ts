declare module "bare-subprocess" {
  import { EventEmitter } from "events";

  export interface SpawnOptions {
    stdio?: "inherit"[] | "pipe"[] | "ignore"[];
    env?: Record<string, string>;
    cwd?: string;
    detached?: boolean;
    uid?: number;
    gid?: number;
  }

  export class ChildProcess extends EventEmitter {
    constructor();

    pid: number | null;
    killed: boolean;
    connected: boolean;

    kill(signal?: string): boolean;
    on(
      event: "exit",
      listener: (code: number | null, signal: string | null) => void,
    ): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(
      event: "close",
      listener: (code: number | null, signal: string | null) => void,
    ): this;
  }

  export function spawn(
    command: string,
    args?: string[],
    options?: SpawnOptions,
  ): ChildProcess;
  export function exec(command: string, options?: SpawnOptions): ChildProcess;
}
