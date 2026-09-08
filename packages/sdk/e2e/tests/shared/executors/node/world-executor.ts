import * as fs from 'node:fs'
import * as path from 'node:path'
import { WorldExecutor as SharedWorldExecutor, type WorldParams } from '../world-executor.js'

function readImageBytes(name: string): Uint8Array {
  const fileName = name.split('/').pop()!
  const filePath = path.resolve(process.cwd(), 'assets/images', fileName)
  return new Uint8Array(fs.readFileSync(filePath))
}

export class NodeWorldExecutor extends SharedWorldExecutor {
  // Resolve the first-frame filename declared in test params to bytes via Node
  // fs, keeping the shared executor free of any filesystem API.
  protected override async resolveParams(p: WorldParams): Promise<WorldParams> {
    if (typeof p.image !== 'string') return p
    return { ...p, image: readImageBytes(p.image) }
  }
}
