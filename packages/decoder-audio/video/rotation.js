"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.displayRotation = displayRotation;
exports.rotateRgb = rotateRgb;
const error_1 = require("../utils/error");
const config_1 = require("./config");
/** QuickTime/FFmpeg display matrices use fixed-point coefficients. Mirroring/shear are not rotation. */
function displayRotation(data) {
    if (!data)
        return 0;
    if (data.byteLength !== 36)
        throw (0, config_1.videoError)(error_1.ERR_CODES.INVALID_VIDEO_INPUT, "Invalid display matrix");
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const a = view.getInt32(0, true) / 65536;
    const b = view.getInt32(4, true) / 65536;
    const c = view.getInt32(12, true) / 65536;
    const d = view.getInt32(16, true) / 65536;
    const close = (x, y) => Math.abs(x - y) < 0.0001;
    if (view.getInt32(8, true) !== 0 || view.getInt32(20, true) !== 0 || view.getInt32(32, true) !== 1073741824) {
        throw (0, config_1.videoError)(error_1.ERR_CODES.UNSUPPORTED_VIDEO, "Perspective display transforms are unsupported");
    }
    if (close(a, 1) && close(b, 0) && close(c, 0) && close(d, 1))
        return 0;
    if (close(a, 0) && close(b, 1) && close(c, -1) && close(d, 0))
        return 90;
    if (close(a, -1) && close(b, 0) && close(c, 0) && close(d, -1))
        return 180;
    if (close(a, 0) && close(b, -1) && close(c, 1) && close(d, 0))
        return 270;
    throw (0, config_1.videoError)(error_1.ERR_CODES.UNSUPPORTED_VIDEO, "Only unmirrored right-angle video rotation is supported");
}
function rotateRgb(rgb, width, height, rotation) {
    const turned = rotation === 90 || rotation === 270;
    const outputWidth = turned ? height : width;
    const outputHeight = turned ? width : height;
    const output = new Uint8Array(rgb.byteLength);
    if (rotation === 0)
        output.set(rgb);
    else
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const dx = rotation === 90 ? height - 1 - y : rotation === 180 ? width - 1 - x : y;
                const dy = rotation === 90 ? x : rotation === 180 ? height - 1 - y : width - 1 - x;
                const source = (y * width + x) * 3;
                output.set(rgb.subarray(source, source + 3), (dy * outputWidth + dx) * 3);
            }
        }
    return { rgb: output, width: outputWidth, height: outputHeight };
}
