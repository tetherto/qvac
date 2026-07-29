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
 * The bar is one fixed-height line, so its width budget is finite and the copy
 * has to be rationed per breakpoint. Measured at 14px Inter / 12px mono, with
 * the close button eating ~38px on the right:
 *
 * - headline (`label` + `title`) ≈ 148px
 * - `description` ≈ 405px more
 * - CTA button ≈ 119px
 *
 * Hence two layouts instead of one: below `sm` the CTA button is replaced by a
 * chevron and the whole row becomes the link, which frees the button's 119px
 * (the headline then fits down to ~250px viewports) and turns the bar itself
 * into the tap target. The copy is rendered twice, one variant per breakpoint;
 * `display: none` keeps the inactive one out of the accessibility tree.
 */
export function AnnouncementBanner() {
  if (!announcement) return null;

  const { id, label, title, description, cta } = announcement;
  const headline = <Headline label={label} title={title} />;

  return (
    <Banner id={id} className="border-b border-fd-border/60">
      {/*
       * Mobile: no button, the row is the link. `h-full` stretches it over the
       * whole bar so the tap target is the bar and not just the text, and
       * `pe-8` keeps the copy clear of the close button (which is absolutely
       * positioned, therefore painted above this link and still clickable).
       */}
      {cta ? (
        <a
          href={cta.href}
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-full w-full items-center justify-center gap-1.5 pe-8 transition-colors active:bg-fd-primary/10 sm:hidden"
        >
          <span className="min-w-0 truncate">{headline}</span>
          <ChevronRight className="size-3.5 shrink-0 text-fd-primary" />
        </a>
      ) : (
        <div className="flex w-full items-center justify-center pe-8 sm:hidden">
          <span className="min-w-0 truncate">{headline}</span>
        </div>
      )}

      {/*
       * Desktop: headline + CTA button, with symmetric `px-8` so the copy stays
       * visually centered while clearing the close button.
       */}
      <div className="hidden w-full items-center justify-center gap-3 px-8 sm:flex">
        <p className="min-w-0 truncate">
          {headline}{' '}
          {/*
           * Headline + description + button + padding measure ~786px, which
           * falls between `md` (768px) and `lg` (1024px) — hence the arbitrary
           * breakpoint rather than a token: `md` clips the last words and `lg`
           * would waste the ~240px in between. `truncate` above stays as the
           * backstop for a longer announcement.
           */}
          <span className="hidden text-fd-primary min-[800px]:inline">
            {description}
          </span>
        </p>
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

function Headline({ label, title }: { label: string; title: string }) {
  return (
    <>
      <span className="font-semibold text-fd-primary">{label}</span>{' '}
      <span className="text-fd-foreground">{title}</span>
    </>
  );
}
