import fs from 'bare-fs'
import path from 'bare-path'

export function fitModelPath(modelPath: string): string {
  try {
    return path.join(fs.realpathSync(path.dirname(modelPath)), path.basename(modelPath))
  } catch {
    return path.resolve(modelPath)
  }
}
