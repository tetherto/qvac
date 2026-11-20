import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  DiffusionExecutor as SharedDiffusionExecutor,
  type DiffusionParams
} from '../diffusion-executor.js'

function readImageBytes(name: string): Uint8Array {
  const fileName = name.split('/').pop()!
  const filePath = path.resolve(process.cwd(), 'assets/images', fileName)
  return new Uint8Array(fs.readFileSync(filePath))
}

export class NodeDiffusionExecutor extends SharedDiffusionExecutor {
  // Resolve string filenames declared in test params to bytes via Node fs.
  protected override async resolveParams(p: DiffusionParams): Promise<DiffusionParams> {
    const out: DiffusionParams = { ...p }

    if (typeof p.initImage === 'string') {
      out.initImage = readImageBytes(p.initImage)
    }

    if (typeof p.image === 'string') {
      out.image = readImageBytes(p.image)
    }

    if (Array.isArray(p.initImages)) {
      if (!p.initImages.every((v): v is string => typeof v === 'string')) {
        throw new Error('initImages in test params must be a string[] of image filenames')
      }
      out.initImages = p.initImages.map(readImageBytes)
    }

    return out
  }
}
