declare module "bare-runtime/spawn" {
  export interface SpawnOptions {
    args?: string[];
    stdio?: string[];
  }

  export interface ChildProcess {
    pid: number | null;
    killed: boolean;
    kill(signal?: string): boolean;
  }

  export default function spawn(
    command: string,
    options?: SpawnOptions,
  ): ChildProcess;
}
