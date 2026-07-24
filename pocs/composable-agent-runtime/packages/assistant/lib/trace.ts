let traceSequence = 0

export function createTraceId() {
  traceSequence = (traceSequence + 1) % Number.MAX_SAFE_INTEGER
  const time = Date.now().toString(36)
  const sequence = traceSequence.toString(36)
  const entropy = Math.floor(Math.random() * 0x1_0000_0000)
    .toString(36)
    .padStart(7, '0')

  return `trc_${time}_${sequence}_${entropy}`
}
