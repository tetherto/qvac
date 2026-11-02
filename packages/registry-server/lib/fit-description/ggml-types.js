'use strict'

const GGML_TYPE_F32 = 0
const GGML_TYPE_I32 = 26

const GGML_TYPE_TABLE = [
  { name: 'f32', id: GGML_TYPE_F32, blockSize: 1, typeSize: 4 },
  { name: 'f16', id: 1, blockSize: 1, typeSize: 2 },
  { name: 'q4_0', id: 2, blockSize: 32, typeSize: 18 },
  { name: 'q4_1', id: 3, blockSize: 32, typeSize: 20 },
  { name: 'q5_0', id: 6, blockSize: 32, typeSize: 22 },
  { name: 'q5_1', id: 7, blockSize: 32, typeSize: 24 },
  { name: 'q8_0', id: 8, blockSize: 32, typeSize: 34 },
  { name: 'q8_1', id: 9, blockSize: 32, typeSize: 36 },
  { name: 'q2_K', id: 10, blockSize: 256, typeSize: 84 },
  { name: 'q3_K', id: 11, blockSize: 256, typeSize: 110 },
  { name: 'q4_K', id: 12, blockSize: 256, typeSize: 144 },
  { name: 'q5_K', id: 13, blockSize: 256, typeSize: 176 },
  { name: 'q6_K', id: 14, blockSize: 256, typeSize: 210 },
  { name: 'q8_K', id: 15, blockSize: 256, typeSize: 292 },
  { name: 'iq2_xxs', id: 16, blockSize: 256, typeSize: 66 },
  { name: 'iq2_xs', id: 17, blockSize: 256, typeSize: 74 },
  { name: 'iq3_xxs', id: 18, blockSize: 256, typeSize: 98 },
  { name: 'iq1_s', id: 19, blockSize: 256, typeSize: 50 },
  { name: 'iq4_nl', id: 20, blockSize: 32, typeSize: 18 },
  { name: 'iq3_s', id: 21, blockSize: 256, typeSize: 110 },
  { name: 'iq2_s', id: 22, blockSize: 256, typeSize: 82 },
  { name: 'iq4_xs', id: 23, blockSize: 256, typeSize: 136 },
  { name: 'i8', id: 24, blockSize: 1, typeSize: 1 },
  { name: 'i16', id: 25, blockSize: 1, typeSize: 2 },
  { name: 'i32', id: GGML_TYPE_I32, blockSize: 1, typeSize: 4 },
  { name: 'i64', id: 27, blockSize: 1, typeSize: 8 },
  { name: 'f64', id: 28, blockSize: 1, typeSize: 8 },
  { name: 'iq1_m', id: 29, blockSize: 256, typeSize: 56 },
  { name: 'bf16', id: 30, blockSize: 1, typeSize: 2 },
  { name: 'tq1_0', id: 34, blockSize: 256, typeSize: 54 },
  { name: 'tq2_0', id: 35, blockSize: 256, typeSize: 66 },
  { name: 'mxfp4', id: 39, blockSize: 32, typeSize: 17 }
]

const GGML_TYPE_LAYOUTS = new Map(GGML_TYPE_TABLE.map((layout) => [layout.id, layout]))

function isKnownGgmlType(type) {
  return GGML_TYPE_LAYOUTS.has(type)
}

function product(values) {
  return values.reduce((total, value) => total * value, 1)
}

function leadingDimension(ne) {
  return ne.length === 0 ? 1 : ne[0]
}

function rowsAreWhole(type, ne) {
  return leadingDimension(ne) % GGML_TYPE_LAYOUTS.get(type).blockSize === 0
}

function ggmlTensorBytes(type, ne) {
  const { blockSize, typeSize } = GGML_TYPE_LAYOUTS.get(type)
  return (leadingDimension(ne) / blockSize) * typeSize * product(ne.slice(1))
}

module.exports = {
  GGML_TYPE_F32,
  GGML_TYPE_I32,
  isKnownGgmlType,
  rowsAreWhole,
  ggmlTensorBytes
}
