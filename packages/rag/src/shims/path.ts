import { QvacErrorRAG, ERR_CODES } from '../errors.js'

export interface QvacPath {
  join(...parts: string[]): string
}

function ensurePath(): QvacPath {
  const path = (globalThis as { path?: QvacPath }).path
  if (path && path !== pathShim) {
    return path
  }
  throw new QvacErrorRAG({
    code: ERR_CODES.DEPENDENCY_REQUIRED,
    adds: 'No path implementation is available for TurboVec checkpoints'
  })
}

const pathShim: QvacPath = new Proxy({} as QvacPath, {
  get(_target, prop) {
    return ensurePath()[prop as keyof QvacPath]
  }
})

export default pathShim
