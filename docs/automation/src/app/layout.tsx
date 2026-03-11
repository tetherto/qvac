import type { Metadata } from 'next';
import { RootProvider } from 'fumadocs-ui/provider';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'QVAC Documentation',
  description: 'QVAC SDK and API Documentation',
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider
          search={{
            enabled: false, // Fumadocs search dialog lacks DialogTitle; disable until fixed to avoid a11y console error
          }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
