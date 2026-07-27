export interface AddonLogging {
    setLogger(this: void, callback: (priority: number, message: string) => void): void;
    releaseLogger(this: void): void;
}
export declare const setLogger: (this: void, callback: (priority: number, message: string) => void) => void;
export declare const releaseLogger: (this: void) => void;
declare const addonLogging: AddonLogging;
export default addonLogging;
