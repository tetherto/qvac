import { QvacErrorRAG, ERR_CODES } from '../errors.js'

export interface QvacFileSystem {
  existsSync(path: string): boolean
  mkdirSync(path: string, options?: { recursive?: boolean }): void
  readFileSync(path: string, encoding: 'utf8'): string
  writeFileSync(path: string, data: string): void
  renameSync(from: string, to: string): void
  readdirSync(path: string): string[]
  unlinkSync(path: string): void
  rmdirSync(path: string): void
  statSync(path: string): { mtimeMs: number }
  openSync(path: string, flags: string): number
  closeSync(fd: number): void
  fsyncSync(fd: number): void
}

function ensureFileSystem(): QvacFileSystem {
  const fileSystem = (globalThis as { fs?: QvacFileSystem }).fs
  if (fileSystem && fileSystem !== fsShim) {
    return fileSystem
  }
  throw new QvacErrorRAG({
    code: ERR_CODES.DEPENDENCY_REQUIRED,
    adds: 'No filesystem implementation is available for TurboVec checkpoints'
  })
}

const fsShim: QvacFileSystem = new Proxy({} as QvacFileSystem, {
  get(_target, prop) {
    return ensureFileSystem()[prop as keyof QvacFileSystem]
  }
})

export default fsShim
