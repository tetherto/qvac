'use client';

import { useEffect, useRef, type ReactNode } from 'react';

interface TrackCopyProps {
  /**
   * Value written to the wrapped copy button's `data-track-name`
   * attribute so analytics (e.g. Google Tag Manager) can target this
   * specific code block's copy interaction.
   */
  name: string;
  children: ReactNode;
}

/**
 * Wraps a single Fumadocs code block and stamps `data-track-name` onto
 * its copy `<button>`. Fumadocs renders the copy button internally (it
 * is not exposed as a customizable component), so we tag it from the
 * rendered DOM after hydration. The attribute persists even when the
 * button's `aria-label` toggles between "Copy Text" / "Copied Text".
 */
export function TrackCopy({ name, children }: TrackCopyProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const button = ref.current?.querySelector('button');
    button?.setAttribute('data-track-name', name);
  }, [name]);

  return <div ref={ref}>{children}</div>;
}
