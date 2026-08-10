export interface AddonLogging {
    setLogger(callback: (priority: number, message: string) => void): void;
    releaseLogger(): void;
}
declare const addonLogging: AddonLogging;
export declare const setLogger: (callback: (priority: number, message: string) => void) => void;
export declare const releaseLogger: () => void;
export default addonLogging;
