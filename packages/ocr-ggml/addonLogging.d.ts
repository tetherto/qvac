type NativeLoggerCallback = (priority: number, message: string) => void;
interface AddonLogging {
    setLogger: (callback: NativeLoggerCallback) => void;
    releaseLogger: () => void;
}
declare const addonLogging: AddonLogging;
export = addonLogging;
