# Provenance

This library is derived from Kazuhiko Arase's qrcode-generator 2.0.4,
upstream tag `js2.0.4`, commit `83b7e8fe3fddd3b0368dbafd6ce56995bd25e3c8`.
Source: https://github.com/kazuhikoarase/qrcode-generator.
The original MIT license and attribution remain in LICENSE and index.js.

Tether modifications: retain only the matrix factory (addData, make,
getModuleCount, isDark); remove HTML, SVG, GIF, canvas, ASCII, base64 and
Shift-JIS/Kanji helpers; keep Numeric, Alphanumeric and original Latin-1 Byte
encoding. Encoding, masking, error correction and capacity algorithms are
unchanged. Internal comparisons use strict equality. Add ESM exports, types and Node/Bare Brittle tests. Original upstream
sources remain in this checkout for provenance and parity tests, but are not
included in the published library.
