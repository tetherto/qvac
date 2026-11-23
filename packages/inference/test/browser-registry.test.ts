import test from 'brittle'
import { findModelShards, huggingFaceUrl, selectDeclaredShards } from '@/browser/registry'
import { models } from '@/models/registry/models'

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

test('findModelShards: catalog metadata supplies the complete declared group', async (t) => {
  const model = models.find(
    (candidate) => candidate.registrySource === 'hf' && 'shardMetadata' in candidate
  )!
  if (!('shardMetadata' in model)) throw new Error('Expected a sharded Hugging Face model')
  const shards = await findModelShards(model.registryPath)
  t.is(shards.length, model.shardMetadata.length)
  t.alike(
    selectDeclaredShards(model.registryPath, shards).map((shard) => shard.path),
    shards.map((shard) => shard.path)
  )
  t.exception(() => selectDeclaredShards(model.registryPath, shards.slice(1)), /Expected .* shards/)
})
