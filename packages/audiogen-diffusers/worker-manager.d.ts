import { type RuntimeConfig, type WorkerEvent, type WorkerRequest } from './protocol';
export declare class MiniMaxDiffusersWorker {
    private readonly pythonPath;
    private readonly onEvent;
    private child;
    private pending;
    constructor(pythonPath: string, onEvent: (event: WorkerEvent) => void);
    start(): void;
    load(config: RuntimeConfig): void;
    generate(request: Omit<Extract<WorkerRequest, {
        op: 'generate';
    }>, 'version' | 'op'>): void;
    cancel(requestId: string): void;
    unload(): void;
    destroy(): void;
    private send;
    private consume;
}
