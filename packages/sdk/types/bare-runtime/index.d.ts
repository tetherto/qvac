declare module "bare-runtime/spawn" {
  export interface SpawnOptions {
    args?: string[];
    stdio?: string[];
  }

  export interface ChildProcess {
    pid: number | null;
    killed: boolean;
    kill(signal?: string): boolean;
    on(
      event: "exit",
      listener: (code: number | null, signal: string | null) => void,
    ): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  export default function spawn(
    command: string,
    options?: SpawnOptions,
  ): ChildProcess;
}
