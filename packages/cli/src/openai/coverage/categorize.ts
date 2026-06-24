import type { CoverageCategory, SpecEntry, UnknownLabelCount } from './types.js'

/** OpenAPI operation tags (title case in spec). Matched case-insensitively. */
const PRIMARY_TAGS = [
  'Chat',
  'Audio',
  'Completions',
  'Embeddings',
  'Images',
  'Responses',
  'Realtime',
  'Videos'
]

const AI_SECONDARY_TAGS = [
  'Models',
  'Files',
  'Vector stores',
  'Vector store files',
  'Vector store file batches'
]

const PLATFORM_TAGS = [
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
  'Organization',
  // Org / IAM surface (OpenAPI tag names)
  'Certificates',
  'Roles',
  'Groups',
  'Group organization role assignments',
  'Group users',
  'Project groups',
  'User organization role assignments',
  'Project group role assignments',
  'Project user role assignments'
]

/** x-oaiMeta.group slugs (typically lowercase). Checked before tag names. */
const GROUP_CATEGORY: Record<string, CoverageCategory> = {
  chat: 'primary-ai',
  audio: 'primary-ai',
  completions: 'primary-ai',
  embeddings: 'primary-ai',
  images: 'primary-ai',
  responses: 'primary-ai',
  realtime: 'primary-ai',
  videos: 'primary-ai',
  models: 'ai-secondary',
  files: 'ai-secondary',
  vector_stores: 'ai-secondary',
  administration: 'platform',
  containers: 'platform',
  chatkit: 'platform',
  assistants: 'platform',
  threads: 'platform',
  batches: 'platform',
  uploads: 'platform',
  evals: 'platform',
  'fine-tuning': 'platform',
  moderations: 'platform',
  skills: 'platform',
  conversations: 'platform',
  organization: 'platform',
  usage: 'platform'
}

function normalizeLabel (label: string): string {
  return label.trim().toLowerCase()
}

const PRIMARY_NORM = new Set(PRIMARY_TAGS.map(normalizeLabel))
const AI_SECONDARY_NORM = new Set(AI_SECONDARY_TAGS.map(normalizeLabel))
const PLATFORM_NORM = new Set(PLATFORM_TAGS.map(normalizeLabel))

function categoryFromTag (tag: string): CoverageCategory | null {
  const n = normalizeLabel(tag)
  if (PRIMARY_NORM.has(n)) return 'primary-ai'
  if (AI_SECONDARY_NORM.has(n)) return 'ai-secondary'
  if (PLATFORM_NORM.has(n)) return 'platform'
  return null
}

export function categorize (entry: Pick<SpecEntry, 'tags' | 'group'>): CoverageCategory {
  if (entry.group) {
    const slug = entry.group.trim().toLowerCase()
    const fromGroup = GROUP_CATEGORY[slug]
    if (fromGroup) return fromGroup
  }

  for (const tag of entry.tags) {
    const fromTag = categoryFromTag(tag)
    if (fromTag) return fromTag
  }

  return 'unknown'
}

/** Count OpenAPI tags and x-oaiMeta.group values on uncategorized operations. */
export function summarizeUnknownLabels (
  entries: Array<Pick<SpecEntry, 'tags' | 'group'>>
): UnknownLabelCount[] {
  const tagCounts = new Map<string, number>()
  const groupCounts = new Map<string, number>()

  for (const entry of entries) {
    if (categorize(entry) !== 'unknown') continue
    for (const tag of entry.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
    }
    if (entry.group) {
      groupCounts.set(entry.group, (groupCounts.get(entry.group) ?? 0) + 1)
    }
  }

  const out: UnknownLabelCount[] = []
  for (const [label, count] of tagCounts) {
    out.push({ label, kind: 'tag', count })
  }
  for (const [label, count] of groupCounts) {
    out.push({ label, kind: 'group', count })
  }
  out.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  return out
}
