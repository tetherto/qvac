import { describe, it, expect } from 'vitest';
import { announcement } from '@/lib/announcement';

/**
 * The banner is content shipped in code, so the only thing a test can protect
 * is the shape of that content: a malformed announcement renders a broken bar
 * on every page of the site. Every assertion is skipped when the announcement
 * is intentionally taken down (`null`).
 */
describe('announcement config', () => {
  it.skipIf(!announcement)(
    'uses a slug-shaped id, so the dismissal key is stable and readable',
    () => {
      expect(announcement!.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    },
  );

  it.skipIf(!announcement)('has no empty or untrimmed copy slot', () => {
    for (const slot of ['label', 'title', 'description'] as const) {
      const value = announcement![slot];
      expect(value.length, `${slot} is empty`).toBeGreaterThan(0);
      expect(value, `${slot} has surrounding whitespace`).toBe(value.trim());
    }
  });

  it.skipIf(!announcement?.cta)(
    'points the CTA at an absolute https URL',
    () => {
      const { href, text } = announcement!.cta!;

      expect(text.length).toBeGreaterThan(0);
      expect(href).toMatch(/^https:\/\//);
      expect(() => new URL(href)).not.toThrow();
    },
  );
});
