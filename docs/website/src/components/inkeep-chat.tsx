'use client';

import dynamic from 'next/dynamic';

const InkeepScript = dynamic(() => import('./inkeep-script').then(m => ({ default: m.InkeepScript })), {
  ssr: false,
});

export function InkeepChat() {
  return <InkeepScript />;
}
