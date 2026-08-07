type NativeLoggerCallback = (priority: number, message: string) => void;
export interface AddonLogging {
    setLogger: (callback: NativeLoggerCallback) => void;
    releaseLogger: () => void;
}
declare const addonLogging: AddonLogging;
export declare const setLogger: AddonLogging["setLogger"];
export declare const releaseLogger: AddonLogging["releaseLogger"];
export default addonLogging;
