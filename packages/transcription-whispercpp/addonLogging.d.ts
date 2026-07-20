type NativeLoggerCallback = (priority: number, message: string) => void;
export interface AddonLogging {
    setLogger: (callback: NativeLoggerCallback) => void;
    releaseLogger: () => void;
}
export declare const setLogger: (callback: NativeLoggerCallback) => void;
export declare const releaseLogger: () => void;
declare const addonLogging: AddonLogging;
export default addonLogging;
