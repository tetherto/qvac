import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const pages = [
  'completion',
  'cancel',
  'tools',
  'sharded',
  'multimodal',
  'lora',
  'speculative',
  'batch',
  'kv-cache',
  'fit-finetune'
]

export default {
  optimizeDeps: { exclude: ['@qvac/llm-llamacpp'] },
  worker: { format: 'es' },
  build: {
    rollupOptions: {
      input: Object.fromEntries([
        ['index', resolve(root, 'index.html')],
        ...pages.map((page) => [page, resolve(root, page, 'index.html')])
      ])
    }
  }
}
