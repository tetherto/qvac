import { source } from '@/lib/source';
import { createSearchAPI } from 'fumadocs-core/search/server';

const searchAPI = createSearchAPI('simple', {
  indexes: () => {
    const pages = source.getPages();
    return pages.map((page) => ({
      title: page.data.title,
      description: page.data.description ?? undefined,
      content: [page.data.title, page.data.description].filter(Boolean).join(' '),
      url: page.url,
    }));
  },
  language: 'english',
});

export const { GET } = searchAPI;
