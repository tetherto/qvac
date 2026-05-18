import type { CoverageCategory, SpecEntry } from './types.js'

const PRIMARY_TAGS = new Set([
  'Chat',
  'Audio',
  'Completions',
  'Embeddings',
  'Images',
  'Responses',
  'Realtime',
  'Videos'
])

const AI_SECONDARY_TAGS = new Set([
  'Models',
  'Files',
  'Vector stores',
  'Vector store files',
  'Vector store file batches'
])

const PLATFORM_TAGS = new Set([
  'Assistants',
  'Audit Logs',
  'Batch',
  'Containers',
  'Conversations',
  'Evals',
  'Fine-tuning',
  'Graders',
  'Moderations',
  'Threads',
  'Uploads',
  'Skills',
  'ChatKit',
  'Usage',
  'Invites',
  'Users',
  'Projects',
  'Organization'
])

export function categorize (entry: Pick<SpecEntry, 'tags' | 'group'>): CoverageCategory {
  const labels = new Set<string>([...entry.tags, ...(entry.group ? [entry.group] : [])])
  for (const label of labels) {
    if (PRIMARY_TAGS.has(label)) return 'primary-ai'
  }
  for (const label of labels) {
    if (AI_SECONDARY_TAGS.has(label)) return 'ai-secondary'
  }
  for (const label of labels) {
    if (PLATFORM_TAGS.has(label)) return 'platform'
  }
  return 'unknown'
}
