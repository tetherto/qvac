import type { ReactNode } from 'react';

// Server-component wrapper for the `/keet` route. Its only job is to declare
// route metadata: the launcher page itself (`page.tsx`) is a client component
// (`'use client'`) because it needs hooks like `useTheme`/`useState`, and Next
// ignores `metadata` exports from client components. Without this layout, the
// browser tab title falls back to the root layout ("QVAC by Tether"), which
// hides what the page actually is when users tab-switch, bookmark it, or when
// a link preview uses the title as fallback.
export const metadata = {
  title: 'Join QVAC Keet Room',
};

export default function KeetLayout({ children }: { children: ReactNode }) {
  return children;
}
