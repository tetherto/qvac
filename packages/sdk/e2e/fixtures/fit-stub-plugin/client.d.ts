export interface FitStubCheckParams {
  nCtx?: number
  marginMiB?: number
  backendsDir?: string
}

export interface FitStubPlan {
  status: number
  fits: boolean
  reason: string
  nGpuLayers: number
  nCtx: number
  nBatch: number
  nUbatch: number
  splitMode: number
  mainGpu: number
  typeK: number
  typeV: number
  flashAttnType: number
  tensorSplit: number[]
  buftOverrides: number
  nDevices: number
  nGpuDevices: number
}

export interface FitStubCheckReport {
  platform: string
  modelPath: string
  nCtx: number
  marginMiB: number
  header: {
    version: number
    nTensors: number
    nKv: number
    tokenizerKv: number
    tensorInfoBytes: number
    headerEnd: number
    dataOffset: number
    fullSize: number
  } | null
  stub: {
    path: string
    apparentSize: number
    allocatedBytes: number | null
    sparse: boolean | string
    apparentMatchesFull: boolean
  } | null
  fit: {
    backendsDir: string | null
    full: FitStubPlan | null
    stub: FitStubPlan | null
    identical: boolean | null
    ms: { full?: number; stub?: number }
  } | null
  errors: Record<string, string>
  totalMs: number
  verdict: { sparseOk: boolean; stubLoads: boolean; planIdentical: boolean; pass: boolean }
}

export function fitStubCheck(
  modelId: string,
  params?: FitStubCheckParams
): Promise<FitStubCheckReport>
