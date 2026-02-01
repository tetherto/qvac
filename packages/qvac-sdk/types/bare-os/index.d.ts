declare module "bare-os" {
  export interface UserInfo {
    username: string;
    uid: number;
    gid: number;
    shell: string;
    homedir: string;
  }

  export function arch(): string;
  export function platform(): string;
  export function type(): string;
  export function release(): string;
  export function version(): string;
  export function endianness(): "BE" | "LE";
  export function tmpdir(): string;
  export function homedir(): string;
  export function hostname(): string;
  export function loadavg(): [number, number, number];
  export function uptime(): number;
  export function freemem(): number;
  export function totalmem(): number;
  export function cpus(): Array<{
    model: string;
    speed: number;
    times: {
      user: number;
      nice: number;
      sys: number;
      idle: number;
      irq: number;
    };
  }>;
  export function networkInterfaces(): Record<
    string,
    Array<{
      address: string;
      netmask: string;
      family: "IPv4" | "IPv6";
      mac: string;
      internal: boolean;
      cidr: string;
    }>
  >;
  export function userInfo(options?: { encoding: "buffer" }): UserInfo;
}
