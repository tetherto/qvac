export type VideoRotation = 0 | 90 | 180 | 270;
/** QuickTime/FFmpeg display matrices use fixed-point coefficients. Mirroring/shear are not rotation. */
export declare function displayRotation(data?: Uint8Array): VideoRotation;
export declare function rotateRgb(rgb: Uint8Array, width: number, height: number, rotation: VideoRotation): {
    rgb: Uint8Array<ArrayBuffer>;
    width: number;
    height: number;
};
