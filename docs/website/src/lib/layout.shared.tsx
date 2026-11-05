import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

/**
 * Shared layout configurations
 *
 * you can customise layouts individually from:
 * Home Layout: app/(home)/layout.tsx
 * Docs Layout: app/docs/layout.tsx
 */
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      // `/` only exists as a redirect to this page, so the logo targets it
      // directly rather than sending every visitor through an extra hop.
      url: '/ecosystem',
      title: (
        <img
          src="/qvac-logo.svg"
          alt="QVAC Logo"
          className="h-7 w-auto max-w-full"
        />
      ),
    },
    // see https://fumadocs.dev/docs/ui/navigation/links
  };
}
