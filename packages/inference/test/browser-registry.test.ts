import test from 'brittle'
import { huggingFaceUrl } from '@/browser/registry'

// The browser build downloads Hugging Face-hosted registry models from their
// catalogued origin; registry paths use either `blob` or `resolve` links.

test('huggingFaceUrl: a blob path becomes a resolve download URL', (t) => {
  t.is(
    huggingFaceUrl(
      'unsloth/Qwen3-0.6B-GGUF/blob/50968a4468ef4233ed78cd7c3de230dd1d61a56b/Qwen3-0.6B-Q4_0.gguf'
    ),
    'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/50968a4468ef4233ed78cd7c3de230dd1d61a56b/Qwen3-0.6B-Q4_0.gguf'
  )
})

test('huggingFaceUrl: a resolve path is kept as is', (t) => {
  t.is(
    huggingFaceUrl(
      'unsloth/Qwen3-1.7B-GGUF/resolve/d7f544eead698dbd1f15126ef60b45a1e1933222/Qwen3-1.7B-Q4_0.gguf'
    ),
    'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/d7f544eead698dbd1f15126ef60b45a1e1933222/Qwen3-1.7B-Q4_0.gguf'
  )
})
