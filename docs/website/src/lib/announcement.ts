/**
 * Site-wide announcement shown by `<AnnouncementBanner />` on every page.
 *
 * This object is the only thing to edit when the announcement changes; set
 * `announcement` to `null` to take the banner down.
 *
 * `id` keys the "dismissed" flag Fumadocs' `<Banner>` persists in
 * `localStorage`, so it MUST change whenever the message does — otherwise a
 * reader who closed the previous announcement never sees the new one.
 *
 * The copy is split in three slots to mirror the banner on qvac.tether.io:
 * `label` and `description` render in the QVAC accent color, `title` in the
 * regular foreground.
 */
export type Announcement = {
  id: string;
  label: string;
  title: string;
  description: string;
  /** External destination of the call-to-action button; `null` for a text-only banner. */
  cta: { text: string; href: string } | null;
};

export const announcement: Announcement | null = {
  id: 'visionpsy-nano-460m',
  label: 'New:',
  title: 'VisionPsy-Nano,',
  description: 'a 460M vision model that outperforms models twice its size.',
  cta: {
    text: 'Download Model',
    href: 'https://huggingface.co/collections/qvac/visionpsy',
  },
};
