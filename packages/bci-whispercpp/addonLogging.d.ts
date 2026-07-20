type NativeLoggerCallback = (priority: number, message: string) => void;
export declare const setLogger: (callback: NativeLoggerCallback) => void;
export declare const releaseLogger: () => void;
export {};
