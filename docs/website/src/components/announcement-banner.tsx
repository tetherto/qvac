import { Banner } from 'fumadocs-ui/components/banner';
import { ChevronRight } from 'lucide-react';
import { announcement } from '@/lib/announcement';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/cn';

/**
 * Announcement bar pinned above the navbar, built on Fumadocs' `<Banner>`.
 *
 * `<Banner>` supplies the two behaviours we'd otherwise hand-roll: the close
 * button (mounted only when an `id` is given, with the dismissal persisted in
 * `localStorage` and re-applied before paint so the bar never flashes for a
 * reader who already closed it) and the `--fd-banner-height` variable the
 * Fumadocs layouts read to push the sticky navbar and shorten the sidebar.
 *
 * Content is edited in `@/lib/announcement`, never here.
 *
 * The bar has a fixed 3rem height, but that buys two lines rather than one: a
 * single 14px line uses 20px of the 48px, and two 12px lines use 32px. So the
 * whole message always renders — narrow viewports buy the room by wrapping,
 * not by hiding words. Measured widths, for the record: the full sentence is
 * ~555px at 14px (~476px at 12px) and the CTA button is ~119px, against a text
 * column of roughly `viewport - 56px` on mobile.
 *
 * Two layouts, one per breakpoint (the copy is rendered twice; `display: none`
 * keeps the inactive variant out of the accessibility tree):
 *
 * - below `sm`, the CTA button gives way to an inline chevron and the whole row
 *   becomes the link. That frees the button's 119px, and the freed width plus
 *   12px type fits the full sentence in two lines down to 320px viewports,
 *   while the bar itself becomes the tap target instead of a 30px button.
 * - from `sm` up, headline and CTA button, wrapping to a second line until the
 *   sentence fits on one (around 790px). No breakpoint drives that — the text
 *   just stops wrapping once there is room.
 *
 * `line-clamp-2` is the backstop in both: a longer future announcement loses
 * its tail to an ellipsis at the end of the second line instead of overflowing
 * the fixed height.
 */
export function AnnouncementBanner() {
  if (!announcement) return null;

  const { id, label, title, description, cta } = announcement;

  const message = (
    <>
      <span className="font-semibold text-fd-primary">{label}</span>{' '}
      <span className="text-fd-foreground">{title}</span>{' '}
      <span className="text-fd-primary">{description}</span>
    </>
  );

  return (
    <Banner id={id} className="border-b border-fd-border/60">
      {/*
       * Mobile: `h-full` stretches the link over the whole bar so the tap
       * target is the bar and not just the text; `text-start` overrides the
       * banner's centering, since centered wrapped lines read as ragged and
       * waste the side margins; `pe-7` keeps the copy clear of the close
       * button, which is absolutely positioned and therefore painted above
       * this link and still clickable.
       */}
      {cta ? (
        <a
          href={cta.href}
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-full w-full items-center pe-7 text-start text-xs transition-colors active:bg-fd-primary/10 sm:hidden"
        >
          <span className="line-clamp-2">
            {message}
            <ChevronRight className="ms-0.5 inline size-3 align-[-0.15em] text-fd-primary" />
          </span>
        </a>
      ) : (
        <div className="flex h-full w-full items-center pe-7 text-start text-xs sm:hidden">
          <span className="line-clamp-2">{message}</span>
        </div>
      )}

      {/*
       * Desktop: headline + CTA button, with symmetric `px-8` so the copy stays
       * visually centered while clearing the close button.
       */}
      <div className="hidden w-full items-center justify-center gap-3 px-8 sm:flex">
        <p className="line-clamp-2 min-w-0">{message}</p>
        {cta ? (
          <a
            href={cta.href}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              buttonVariants({ color: 'outline', size: 'sm' }),
              'shrink-0 whitespace-nowrap border-fd-primary/40 font-mono text-fd-foreground hover:border-fd-primary/70 hover:bg-fd-primary/10 hover:text-fd-primary',
            )}
          >
            {cta.text}
          </a>
        ) : null}
      </div>
    </Banner>
  );
}
