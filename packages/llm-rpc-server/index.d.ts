import type { ChildProcess } from 'node:child_process';
export declare const DEFAULT_RPC_SERVER_HOST: string;
export declare const DEFAULT_RPC_SERVER_START_TIMEOUT_MS: number;
export declare const DEFAULT_RPC_SERVER_SHUTDOWN_GRACE_MS: number;
export declare const RPC_SERVER_HEALTH_POLL_INTERVAL_MS: number;
export declare class RpcServerBinaryNotFoundError extends Error {
    constructor(path: string);
}
export declare class RpcServerUnsupportedPlatformError extends Error {
    constructor(runtimePlatform: string, runtimeArch: string);
}
export declare class RpcServerPortAllocationError extends Error {
    constructor(cause?: unknown);
}
export declare class RpcServerNonLoopbackHostError extends Error {
    constructor(host: string);
}
export declare class RpcServerSpawnError extends Error {
    constructor(message: string, cause?: unknown);
}
export declare class RpcServerExitedError extends Error {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly output: string;
    constructor(code: number | null, signal: NodeJS.Signals | null, output: string);
}
export declare class RpcServerStartTimeoutError extends Error {
    readonly host: string;
    readonly port: number;
    readonly timeoutMs: number;
    readonly output: string;
    constructor(host: string, port: number, timeoutMs: number, output: string);
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
    readonly binaryPath?: string;
    readonly startTimeoutMs?: number;
    readonly shutdownGraceMs?: number;
    readonly env?: NodeJS.ProcessEnv;
    readonly cleanupOnExit?: boolean;
    readonly expectRdma?: boolean;
}
export interface RpcServerProcess {
    readonly child: ChildProcess;
    readonly pid: number;
    readonly host: string;
    readonly port: number;
    readonly url: string;
    readonly device?: string;
    readonly rdmaCapable: boolean;
    logs(): string;
    stop(): Promise<void>;
}
export declare function resolveRpcServerBinaryPath(): string;
export declare function allocateFreePort(host?: string): Promise<number>;
export declare function rpcServerLogsIndicateRdmaSupport(logs: string): boolean;
export declare function startRpcServer(options?: StartRpcServerOptions): Promise<RpcServerProcess>;
