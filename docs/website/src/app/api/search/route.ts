import { source } from '@/lib/source';
import { createFromSource } from 'fumadocs-core/search/server';

// statically cached
export const revalidate = false;
export const { staticGET: GET } = createFromSource(source);