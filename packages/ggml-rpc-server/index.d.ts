export declare const DEFAULT_RPC_SERVER_HOST: string;
export declare class RpcServerPortAllocationError extends Error {
    constructor(cause?: unknown);
}
export declare class RpcServerNonLoopbackHostError extends Error {
    constructor(host: string);
}
export declare class RpcServerInvalidHostError extends Error {
    constructor(host: string);
}
export declare class RpcServerRdmaUnavailableError extends Error {
    readonly output: string;
    constructor(output: string);
}
export interface StartRpcServerOptions {
    readonly device?: string | readonly string[];
    readonly host?: string;
    readonly port?: number;
    readonly cache?: boolean;
    readonly threads?: number;
    readonly expectRdma?: boolean;
    readonly allowNonLoopbackHost?: boolean;
}
export interface RpcServerProcess {
    readonly runtime: 'in-process';
    readonly host: string;
    readonly port: number;
    readonly url: string;
    readonly device?: string;
    readonly rdmaCapable: false;
    logs(): string;
    stop(): Promise<void>;
}
export interface AllocateFreePortOptions {
    readonly allowNonLoopbackHost?: boolean;
}
export declare function allocateFreePort(host?: string, options?: AllocateFreePortOptions): Promise<number>;
export declare function startRpcServer(options?: StartRpcServerOptions): Promise<RpcServerProcess>;
