'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useState, useRef, useEffect, useCallback } from 'react';
import { VERSIONS } from '@/lib/versions';

export function VersionSwitcher() {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);

  const currentVersionMatch = pathname.match(/\/docs\/sdk\/api\/(v[\d.]+|latest)\//);
  const currentVersion = currentVersionMatch?.[1] ?? 'latest';

  const handleVersionChange = useCallback(
    (newVersion: string) => {
      const newPath = pathname.replace(
        /\/docs\/sdk\/api\/(v[\d.]+|latest)\//,
        `/docs/sdk/api/${newVersion}/`,
      );
      router.push(newPath);
      setOpen(false);
      setFocusedIndex(-1);
    },
    [pathname, router],
  );

  const currentVersionLabel =
    VERSIONS.find((v) => v.path === currentVersion)?.label ?? 'Latest';

  // Keyboard: Escape close, ArrowDown/Up navigate, Enter select
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!open) return;
      if (e.key === 'Escape') {
        setOpen(false);
        setFocusedIndex(-1);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedIndex((i) => (i < VERSIONS.length - 1 ? i + 1 : 0));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIndex((i) => (i > 0 ? i - 1 : VERSIONS.length - 1));
        return;
      }
      if (e.key === 'Enter' && focusedIndex >= 0 && VERSIONS[focusedIndex]) {
        e.preventDefault();
        handleVersionChange(VERSIONS[focusedIndex].path);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, focusedIndex, handleVersionChange]);

  // Sync focused index when opening
  useEffect(() => {
    if (open) {
      const idx = VERSIONS.findIndex((v) => v.path === currentVersion);
      setFocusedIndex(idx >= 0 ? idx : 0);
    }
  }, [open, currentVersion]);

  // Focus the focused option into view
  useEffect(() => {
    if (!open || focusedIndex < 0) return;
    const item = listRef.current?.querySelector(`[data-index="${focusedIndex}"]`);
    (item as HTMLElement)?.focus();
  }, [open, focusedIndex]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Switch API documentation version"
        className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm hover:bg-accent"
      >
        {currentVersionLabel}
        <span className="text-muted-foreground" aria-hidden>▾</span>
      </button>
      {open && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-10"
            aria-label="Close"
            onClick={() => setOpen(false)}
          />
          <div
            ref={listRef}
            role="listbox"
            aria-label="API documentation versions"
            className="absolute right-0 top-full z-[100] mt-1 w-56 rounded-lg border border-border bg-white p-2 shadow-lg dark:bg-zinc-900 dark:border-zinc-800"
          >
            {VERSIONS.map((version, index) => (
              <button
                key={version.path}
                type="button"
                role="option"
                aria-selected={version.path === currentVersion}
                data-index={index}
                tabIndex={-1}
                onClick={() => handleVersionChange(version.path)}
                className="flex w-full items-center justify-between rounded px-3 py-2 text-sm hover:bg-zinc-100 focus:bg-zinc-100 focus:outline-none dark:hover:bg-zinc-800 dark:focus:bg-zinc-800"
              >
                <span>{version.label}</span>
                {version.path === currentVersion && (
                  <span className="text-primary" aria-hidden>✓</span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
