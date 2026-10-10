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
    constructor(cause?: unknown);
}
/**
 * A failure reported by the native server. The addon raises plain errors with a
 * `code`; these classes let callers branch on `name` or `instanceof` as they do
 * for the errors above. `code` equals `name`, and `cause` is the native error.
 */
export declare abstract class RpcServerNativeError extends Error {
    readonly code: string;
    constructor(name: string, message: string, cause: unknown);
}
/** No requested device exists, or no device is available. */
export declare class RpcServerDeviceError extends RpcServerNativeError {
    constructor(message: string, cause: unknown);
}
/** The RPC cache directory could not be resolved or created. */
export declare class RpcServerCacheError extends RpcServerNativeError {
    constructor(message: string, cause: unknown);
}
/** The server could not be created or bound, or the RPC backend is missing. */
export declare class RpcServerStartError extends RpcServerNativeError {
    constructor(message: string, cause: unknown);
}
/** The Fabric backends directory is invalid or could not be inspected. */
export declare class RpcServerBackendError extends RpcServerNativeError {
    constructor(message: string, cause: unknown);
}
/** The server did not stop cleanly. */
export declare class RpcServerStopError extends RpcServerNativeError {
    constructor(message: string, cause: unknown);
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
export interface RpcServer {
    readonly host: string;
    readonly port: number;
    readonly url: string;
    readonly device?: string;
    /**
     * Whether new connections will try RDMA: the Fabric RPC backend was built
     * with it, loaded libibverbs, and `GGML_RPC_NO_RDMA` is unset. Each connection
     * still falls back to TCP when the client or the link cannot use RDMA.
     */
    readonly rdmaCapable: boolean;
    stop(): Promise<void>;
}
export interface AllocateFreePortOptions {
    readonly allowNonLoopbackHost?: boolean;
}
/**
 * Finds a port that is free now. Another process can take it before you bind
 * it, so `startRpcServer()` without a `port` lets the server bind one itself.
 */
export declare function allocateFreePort(host?: string, options?: AllocateFreePortOptions): Promise<number>;
export declare function startRpcServer(options?: StartRpcServerOptions): Promise<RpcServer>;
