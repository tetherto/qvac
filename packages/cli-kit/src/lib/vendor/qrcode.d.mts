export type ErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H'
export type Mode = 'Numeric' | 'Alphanumeric' | 'Byte'
export interface QRCode {
  addData(data: string, mode?: Mode): void
  make(): void
  getModuleCount(): number
  isDark(row: number, column: number): boolean
}
/** Version 0 selects the smallest fitting QR. Byte mode preserves upstream Latin-1 encoding. */
export declare function qrcode(version: number, correction: ErrorCorrectionLevel): QRCode
export default qrcode
