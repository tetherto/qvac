export interface AddonLogging {
    setLogger(this: void, callback: (priority: number, message: string) => void): void;
    releaseLogger(this: void): void;
}
export declare const setLogger: AddonLogging["setLogger"];
export declare const releaseLogger: AddonLogging["releaseLogger"];
declare const addonLogging: AddonLogging;
export default addonLogging;
