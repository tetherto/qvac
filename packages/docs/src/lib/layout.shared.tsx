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
