import GGMLBert, { LayaDecisions } from '@qvac/embed-llamacpp'

const rootConstructor: typeof GGMLBert = GGMLBert

void rootConstructor

export function pollingTypes(model: string) {
  return new GGMLBert({
    files: { model: [model] },
    config: { device: 'gpu', poll: '0', 'poll-batch': '0' }
  })
}

// Laya: config (with device) is required. run()'s per-shape result types are
// checked in consumer-interop.test.ts: in this CommonJS setup QvacResponse
// resolves to `any` (infer-base default-imports an `export =` module).
export function layaTypes(model: string) {
  const laya = new LayaDecisions({
    files: { model: [model] },
    config: { device: 'cpu', threads: '4', poll: '0', 'poll-batch': '0' }
  })
  // @ts-expect-error config is required
  void new LayaDecisions({ files: { model: [model] } })
  return laya
}
